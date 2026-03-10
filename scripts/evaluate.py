"""
RAGAS evaluation script for the Olist Analytics Copilot.

Usage
-----
1. Start the full stack (embedding service + ChromaDB + Postgres):
       docker compose up -d

2. Start the Next.js dev server in a separate terminal:
       cd olist-copilot && npm run dev

3. Run evaluation (auto-fetches answers from the running app):
       python scripts/evaluate.py

   To skip auto-fetch and use manually pasted answers instead, set:
       AUTO_FETCH=false python scripts/evaluate.py
   then fill in the `answer` and `contexts` fields in TEST_CASES below.

Additional requirements (install once):
   pip install ragas datasets langchain-google-genai httpx

Results are printed to stdout and saved to ragas_results.json.
"""

import asyncio
import json
import os
import sys
import time

import httpx
from datasets import Dataset
from dotenv import load_dotenv
from ragas import evaluate
from ragas.metrics.collections import AnswerRelevancy, ContextPrecision, Faithfulness
from ragas.run_config import RunConfig

load_dotenv()

# ─── Configuration ─────────────────────────────────────────────────────────────

APP_URL = os.getenv("APP_URL", "http://localhost:3000")
AUTO_FETCH = os.getenv("AUTO_FETCH", "true").lower() == "true"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
RESULTS_FILE = os.getenv("RESULTS_FILE", "ragas_results.json")
# Seconds to pause between app calls to avoid Gemini rate limits inside the app
FETCH_DELAY_SECONDS = float(os.getenv("FETCH_DELAY", "4"))
# RAGAS judge timeout per LLM call (seconds)
RAGAS_TIMEOUT = int(os.getenv("RAGAS_TIMEOUT", "180"))

# ─── Test cases ────────────────────────────────────────────────────────────────
#
# ground_truth describes the *correct semantic definition*, not a hard-coded
# numeric answer, because exact values depend on date filters applied at runtime.
#
# When AUTO_FETCH=false, paste the `answer` and `contexts` from the app UI here.

TEST_CASES = [
    {
        "question": "What was total revenue in 2018?",
        "ground_truth": (
            "Total revenue is the sum of payment_value from delivered orders only. "
            "Cancelled, unavailable, or in-transit orders are excluded. "
            "The answer should reference the analytics.total_revenue view."
        ),
        # --- filled automatically when AUTO_FETCH=true ---
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "How many active customers were there in November 2017?",
        "ground_truth": (
            "Active customers are unique customers (customer_unique_id) who placed "
            "at least one delivered order in the specified period."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "What is the overall order conversion rate?",
        "ground_truth": (
            "Conversion rate is the percentage of created orders that reach delivered "
            "status. Formula: delivered_orders / total_orders * 100."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "What is the average order value per month in 2018?",
        "ground_truth": (
            "Average order value (AOV) is the average revenue per delivered order. "
            "Formula: SUM(payment_value) / COUNT(delivered_orders)."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "What is the average delivery time for orders by customer state?",
        "ground_truth": (
            "Order fulfillment time is the average calendar days from purchase timestamp "
            "to delivery timestamp for delivered orders only, segmented by customer state."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "Which product category generates the most revenue?",
        "ground_truth": (
            "Revenue by category is delivered revenue segmented by product_category_name. "
            "The top category has the highest sum of payment_value across delivered orders."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "What is the customer retention rate for Q1 2018?",
        "ground_truth": (
            "Customer retention rate is the percentage of customers who purchased in "
            "month N and also purchased in month N+1, computed per cohort month."
        ),
        "answer": "",
        "contexts": [""],
    },
    {
        "question": "What are the top 3 product categories by revenue in 2017?",
        "ground_truth": (
            "Revenue by category ranks product_category_name by sum of payment_value "
            "from delivered orders. The top 3 categories have the highest revenue totals."
        ),
        "answer": "",
        "contexts": [""],
    },
]

# ─── Auto-fetch answers from the running Next.js app ───────────────────────────


async def _fetch_one(client: httpx.AsyncClient, question: str) -> dict:
    """POST to /api/query and return the answer + context fields."""
    resp = await client.post(
        f"{APP_URL}/api/query",
        json={"question": question},
        timeout=90.0,
    )
    resp.raise_for_status()
    data = resp.json()
    return {
        "answer": data.get("answer", ""),
        # The route returns `context` (array of retrieved metric definitions)
        "contexts": data.get("context", [""]),
    }


async def _fetch_all(test_cases: list[dict]) -> list[dict]:
    """Call the app sequentially to stay within Gemini rate limits."""
    enriched = []
    async with httpx.AsyncClient() as client:
        for i, tc in enumerate(test_cases, 1):
            prefix = f"[{i}/{len(test_cases)}]"
            print(f"  {prefix} {tc['question'][:65]}...")
            try:
                fetched = await _fetch_one(client, tc["question"])
                enriched.append({**tc, **fetched})
            except httpx.HTTPStatusError as exc:
                print(f"    WARNING: HTTP {exc.response.status_code} — keeping blank answer.")
                enriched.append(tc)
            except Exception as exc:  # noqa: BLE001
                print(f"    WARNING: {exc} — keeping blank answer.")
                enriched.append(tc)
            # Pause between calls to avoid triggering Gemini rate limits inside the app
            if i < len(test_cases) and FETCH_DELAY_SECONDS > 0:
                await asyncio.sleep(FETCH_DELAY_SECONDS)
    return enriched


def fetch_answers(test_cases: list[dict]) -> list[dict]:
    return asyncio.run(_fetch_all(test_cases))


# ─── RAGAS dataset construction ────────────────────────────────────────────────


def build_dataset(test_cases: list[dict]) -> Dataset:
    rows = []
    for tc in test_cases:
        contexts = tc.get("contexts") or [""]
        if isinstance(contexts, str):
            contexts = [contexts]
        rows.append(
            {
                "question": tc["question"],
                "answer": tc.get("answer", ""),
                "contexts": contexts,
                "ground_truth": tc["ground_truth"],
            }
        )
    return Dataset.from_list(rows)


# ─── RAGAS evaluation with Gemini as judge ────────────────────────────────────


def _make_gemini_judge():
    """
    Build a Gemini judge LLM + embeddings for RAGAS 0.4.
    Returns (llm_wrapper, embeddings_wrapper).
    """
    try:
        from langchain_google_genai import (
            ChatGoogleGenerativeAI,
            GoogleGenerativeAIEmbeddings,
        )
        from ragas.embeddings import LangchainEmbeddingsWrapper
        from ragas.llms import LangchainLLMWrapper
    except ImportError as exc:
        sys.exit(
            f"Missing dependency: {exc}\n"
            "Run: pip install langchain-google-genai ragas datasets httpx"
        )

    llm = LangchainLLMWrapper(
        ChatGoogleGenerativeAI(
            model="gemini-3.1-flash-lite-preview",
            google_api_key=GEMINI_API_KEY,
            temperature=0,
            request_timeout=120,
        )
    )
    embeddings = LangchainEmbeddingsWrapper(
        GoogleGenerativeAIEmbeddings(
            model="models/embedding-001",
            google_api_key=GEMINI_API_KEY,
        )
    )
    return llm, embeddings


def run_evaluation(dataset: Dataset):
    if not GEMINI_API_KEY:
        sys.exit(
            "GEMINI_API_KEY is not set.\n"
            "Add it to your .env file or export it before running."
        )

    llm, embeddings = _make_gemini_judge()

    metrics = [
        Faithfulness(llm=llm),
        AnswerRelevancy(llm=llm, embeddings=embeddings),
        ContextPrecision(llm=llm),
    ]

    run_cfg = RunConfig(
        timeout=RAGAS_TIMEOUT,
        max_retries=5,
        max_wait=60,
        max_workers=1,   # one concurrent LLM call — avoids Gemini rate limits
    )

    return evaluate(
        dataset,
        metrics=metrics,
        run_config=run_cfg,
        raise_exceptions=False,
    )


# ─── Pretty-print helpers ──────────────────────────────────────────────────────

_WIDTH = 62


def _bar(score: float | None, width: int = 20) -> str:
    if score is None:
        return "N/A"
    filled = int((score or 0) * width)
    return "█" * filled + "░" * (width - filled)


def print_summary(results) -> dict:
    scores = {
        "faithfulness": results["faithfulness"],
        "answer_relevancy": results["answer_relevancy"],
        "context_precision": results["context_precision"],
    }
    print("\n" + "=" * _WIDTH)
    print("  SUMMARY")
    print("=" * _WIDTH)
    for metric, score in scores.items():
        score_str = f"{score:.4f}" if score is not None else " N/A "
        print(f"  {metric:<24} {score_str}  {_bar(score)}")
    return scores


def print_per_question(results):
    df = results.to_pandas()
    print("\n" + "-" * _WIDTH)
    print("  PER-QUESTION BREAKDOWN")
    print("-" * _WIDTH)
    for _, row in df.iterrows():
        q = str(row["question"])[:65]
        fa = row.get("faithfulness")
        ar = row.get("answer_relevancy")
        cp = row.get("context_precision")

        def fmt(v):
            return f"{v:.3f}" if v is not None else " N/A"

        print(f"\n  Q: {q}")
        print(f"     faithfulness={fmt(fa)}  answer_relevancy={fmt(ar)}  context_precision={fmt(cp)}")


# ─── Entry point ───────────────────────────────────────────────────────────────


def main():
    print("=" * _WIDTH)
    print("  RAGAS Evaluation — Olist Analytics Copilot")
    print("=" * _WIDTH)

    test_cases: list[dict] = [dict(tc) for tc in TEST_CASES]  # shallow copy

    # Step 1 – obtain answers
    if AUTO_FETCH:
        print(f"\nAuto-fetching answers from {APP_URL}/api/query …")
        test_cases = fetch_answers(test_cases)
    else:
        empty_qs = [tc["question"] for tc in test_cases if not tc.get("answer", "").strip()]
        if empty_qs:
            print(
                "\nAUTO_FETCH=false but these questions have no `answer` filled in:\n"
                + "\n".join(f"  • {q}" for q in empty_qs)
                + "\n\nEither set AUTO_FETCH=true or paste answers into TEST_CASES."
            )
            sys.exit(1)

    # Step 2 – build RAGAS dataset
    print("\nBuilding RAGAS dataset …")
    dataset = build_dataset(test_cases)
    print(f"  {len(dataset)} rows ready for evaluation.")

    # Step 3 – evaluate
    print("\nRunning RAGAS evaluation (calls Gemini as judge LLM) …")
    results = run_evaluation(dataset)

    # Step 4 – display
    scores = print_summary(results)
    print_per_question(results)

    # Step 5 – persist to JSON
    df = results.to_pandas()
    output = {
        "summary": scores,
        "per_question": df.to_dict(orient="records"),
        "inputs": [
            {
                "question": tc["question"],
                "answer": tc.get("answer", ""),
                "contexts": tc.get("contexts", [""]),
                "ground_truth": tc["ground_truth"],
            }
            for tc in test_cases
        ],
    }
    with open(RESULTS_FILE, "w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2, default=str)

    print(f"\nFull results saved →  {RESULTS_FILE}")
    print("=" * _WIDTH)


if __name__ == "__main__":
    main()
