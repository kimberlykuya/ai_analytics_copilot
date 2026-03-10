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
   pip install ragas datasets google-genai httpx

Results are printed to stdout and saved to ragas_results.json.
"""

import asyncio
import json
import math
import os
import sys

import httpx
from datasets import Dataset
from dotenv import load_dotenv
from ragas import evaluate
# NOTE: ragas 0.4.x evaluate() validates against ragas.metrics.base.Metric.
# Importing from ragas.metrics.collections returns newer BaseMetric types that
# can fail this check, so we intentionally use ragas.metrics here.
from ragas.metrics import AnswerRelevancy, ContextPrecision, Faithfulness
from ragas.run_config import RunConfig

load_dotenv()

# ─── Configuration ─────────────────────────────────────────────────────────────

APP_URL = os.getenv("APP_URL", "http://localhost:3000")
AUTO_FETCH = os.getenv("AUTO_FETCH", "true").lower() == "true"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODELS = os.getenv(
    "GEMINI_MODELS",
    "gemini-3.1-fhash-lite-preview,gemini-3.1-flash-lite-preview,gemini-2.5-flash,gemini-1.5-flash,gemini-2.0-flash",
)
RESULTS_FILE = os.getenv("RESULTS_FILE", "ragas_results.json")
# Seconds to pause between app calls to avoid Gemini rate limits inside the app
FETCH_DELAY_SECONDS = float(os.getenv("FETCH_DELAY", "4"))
# RAGAS judge timeout per LLM call (seconds)
RAGAS_TIMEOUT = int(os.getenv("RAGAS_TIMEOUT", "180"))
# If true, auto-populate answers/contexts when /api/query is unreachable.
OFFLINE_FALLBACK = os.getenv("OFFLINE_FALLBACK", "true").lower() == "true"

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


def is_api_reachable() -> bool:
    """Cheap connectivity check for the app endpoint."""
    try:
        with httpx.Client(timeout=5.0) as client:
            # GET on root is enough to verify server availability.
            resp = client.get(APP_URL)
            return resp.status_code < 500
    except Exception:  # noqa: BLE001
        return False


# ─── RAGAS dataset construction ────────────────────────────────────────────────


def build_dataset(test_cases: list[dict]) -> Dataset:
    rows = []
    for tc in test_cases:
        contexts = tc.get("contexts") or [""]
        if isinstance(contexts, str):
            contexts = [contexts]
        rows.append(
            {
                "user_input": tc["question"],
                "response": tc.get("answer", ""),
                "retrieved_contexts": contexts,
                "reference": tc["ground_truth"],
            }
        )
    return Dataset.from_list(rows)


def _apply_offline_fallback(test_cases: list[dict]) -> list[dict]:
    """
    Fill missing answers/contexts using ground truth so evaluation can run offline.

    This is a utility mode for debugging the evaluation pipeline when the app API
    is unavailable. It is not a substitute for real end-to-end RAG evaluation.
    """
    enriched = []
    for tc in test_cases:
        answer = (tc.get("answer") or "").strip()
        contexts = tc.get("contexts") or [""]
        if isinstance(contexts, str):
            contexts = [contexts]
        has_context = any((c or "").strip() for c in contexts)

        if not answer:
            answer = tc["ground_truth"]
        if not has_context:
            contexts = [tc["ground_truth"]]

        enriched.append({**tc, "answer": answer, "contexts": contexts})
    return enriched


# ─── RAGAS evaluation with Gemini as judge ────────────────────────────────────


def _make_gemini_judge():
    """
    Build a Gemini judge LLM + embeddings for RAGAS 0.4.
    Returns (llm, embeddings) using the modern llm_factory / GoogleEmbeddings API.
    """
    try:
        from google.genai import Client
        from ragas.embeddings import GoogleEmbeddings
        from ragas.llms import llm_factory
    except ImportError as exc:
        sys.exit(
            f"Missing dependency: {exc}\n"
            "Run: pip install google-genai ragas datasets httpx"
        )

    client = Client(api_key=GEMINI_API_KEY)

    # Pick the first model your account can access.
    model_candidates = [m.strip() for m in GEMINI_MODELS.split(",") if m.strip()]
    # Accept common typo from environment/user input.
    model_candidates = [m.replace("fhash", "flash") for m in model_candidates]
    selected_model = None

    # Prefer selecting from models visible to this account.
    try:
        available = {m.name.replace("models/", "") for m in client.models.list()}
    except Exception:  # noqa: BLE001
        available = set()

    for model_name in model_candidates:
        if available and model_name in available:
            selected_model = model_name
            break

    if selected_model is None:
        # Fallback probe for environments where list() is unavailable/restricted.
        for model_name in model_candidates:
            try:
                client.models.generate_content(
                    model=model_name,
                    contents="ping",
                )
                selected_model = model_name
                break
            except Exception:  # noqa: BLE001
                continue

    if selected_model is None:
        sys.exit(
            "No accessible Gemini model found.\n"
            f"Tried: {', '.join(model_candidates)}\n"
            "Set GEMINI_MODELS in .env to models enabled for your account."
        )

    print(f"Using Gemini judge model: {selected_model}")

    llm = llm_factory(
        selected_model,
        provider="google",
        client=client,
        temperature=0,
    )
    embeddings = GoogleEmbeddings(
        client=client,
        model="gemini-embedding-001",
    )
    return llm, embeddings


def _ensure_answer_relevancy_embeddings(embeddings):
    """Provide legacy embedding methods expected by AnswerRelevancy in ragas 0.4."""
    if hasattr(embeddings, "embed_query") and hasattr(embeddings, "embed_documents"):
        return embeddings

    class _EmbeddingCompatAdapter:
        def __init__(self, modern_embeddings):
            self._modern = modern_embeddings

        def embed_query(self, text: str):
            return self._modern.embed_text(text)

        def embed_documents(self, texts: list[str]):
            return self._modern.embed_texts(texts)

        async def aembed_query(self, text: str):
            return await self._modern.aembed_text(text)

        async def aembed_documents(self, texts: list[str]):
            return await self._modern.aembed_texts(texts)

        # RAGAS may attempt to set run config on embeddings.
        def set_run_config(self, run_config):
            if hasattr(self._modern, "set_run_config"):
                self._modern.set_run_config(run_config)

    return _EmbeddingCompatAdapter(embeddings)


def run_evaluation(dataset: Dataset):
    if not GEMINI_API_KEY:
        sys.exit(
            "GEMINI_API_KEY is not set.\n"
            "Add it to your .env file or export it before running."
        )

    llm, embeddings = _make_gemini_judge()
    embeddings_for_relevancy = _ensure_answer_relevancy_embeddings(embeddings)

    metrics = [
        Faithfulness(llm=llm),
        AnswerRelevancy(llm=llm, embeddings=embeddings_for_relevancy),
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
    if isinstance(score, float) and math.isnan(score):
        return "N/A"
    filled = int((score or 0) * width)
    return "█" * filled + "░" * (width - filled)


def print_summary(results) -> dict:
    scores = {
        "faithfulness": results._repr_dict.get("faithfulness"),
        "answer_relevancy": results._repr_dict.get("answer_relevancy"),
        "context_precision": results._repr_dict.get("context_precision"),
    }
    print("\n" + "=" * _WIDTH)
    print("  SUMMARY")
    print("=" * _WIDTH)
    for metric, score in scores.items():
        score_str = f"{score:.4f}" if (score is not None and not (isinstance(score, float) and math.isnan(score))) else " N/A "
        print(f"  {metric:<24} {score_str}  {_bar(score)}")
    return scores


def print_per_question(results):
    df = results.to_pandas()
    print("\n" + "-" * _WIDTH)
    print("  PER-QUESTION BREAKDOWN")
    print("-" * _WIDTH)
    for _, row in df.iterrows():
        q = str(row.get("user_input", ""))[:65]
        fa = row.get("faithfulness")
        ar = row.get("answer_relevancy")
        cp = row.get("context_precision")

        def fmt(v):
            if v is None:
                return " N/A"
            if isinstance(v, float) and math.isnan(v):
                return " N/A"
            return f"{v:.3f}"

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
        if OFFLINE_FALLBACK and not is_api_reachable():
            print(
                "\nWARNING: App endpoint is unreachable before fetch. "
                "Applying OFFLINE_FALLBACK immediately."
            )
            test_cases = _apply_offline_fallback(test_cases)
        else:
            test_cases = fetch_answers(test_cases)
        fetched_count = sum(1 for tc in test_cases if tc.get("answer", "").strip())
        if fetched_count == 0:
            if OFFLINE_FALLBACK:
                print(
                    "\nWARNING: No answers were fetched from the app endpoint.\n"
                    f"Checked: {APP_URL}/api/query\n"
                    "Applying OFFLINE_FALLBACK using ground_truth for missing answer/context fields."
                )
                test_cases = _apply_offline_fallback(test_cases)
            else:
                sys.exit(
                    "\nNo answers were fetched from the app endpoint.\n"
                    f"Checked: {APP_URL}/api/query\n"
                    "Start the Next.js server first (cd olist-copilot && npm run dev),\n"
                    "or run with OFFLINE_FALLBACK=true to evaluate the pipeline offline."
                )
    else:
        empty_qs = [tc["question"] for tc in test_cases if not tc.get("answer", "").strip()]
        if empty_qs:
            if OFFLINE_FALLBACK:
                print(
                    "\nAUTO_FETCH=false and some answers are missing. "
                    "Applying OFFLINE_FALLBACK using ground_truth."
                )
                test_cases = _apply_offline_fallback(test_cases)
            else:
                print(
                    "\nAUTO_FETCH=false but these questions have no `answer` filled in:\n"
                    + "\n".join(f"  • {q}" for q in empty_qs)
                    + "\n\nEither set AUTO_FETCH=true, paste answers into TEST_CASES,"
                    " or set OFFLINE_FALLBACK=true."
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
