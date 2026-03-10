# olist-copilot — Next.js Frontend

The chat interface and API layer for the AI Analytics Copilot. Users type natural-language business questions; the app runs a three-step RAG pipeline and returns a grounded, data-backed answer.

## Project Problem Statement

Business users cannot self-serve analytics because traditional BI workflows expect SQL proficiency, while unconstrained LLM assistants often hallucinate metric definitions and produce confident but ungrounded answers; this app enforces grounded responses by constraining SQL generation to seven governed metrics and rejecting out-of-scope requests.

## Architecture Diagram

![Simple boxes-and-arrows architecture](../docs/assets/architecture-diagram.svg)

## Grounded vs Out-of-Scope Behavior

![Grounded answer versus out-of-scope rejection](../docs/assets/grounded-vs-rejection.svg)

## Actual RAGAS Scores (Project-Level)

From `../ragas_results.json`:

| Metric | Score |
|---|---:|
| `faithfulness` | `0.15925925925925927` |
| `answer_relevancy` | `0.7108017722304754` |
| `context_precision` | `0.249999999975` |

## Governed Metrics and Business Definitions

| Metric | Business definition |
|---|---|
| `total_revenue` | Total `payment_value` from delivered orders only; excludes cancelled, unavailable, and in-transit orders. |
| `active_customers` | Distinct `customer_unique_id` with at least one delivered order, preventing double counting from address-level customer IDs. |
| `conversion_rate` | Percentage of created orders that reach `delivered` status: `delivered_orders / total_orders * 100`. |
| `average_order_value` | Average revenue per delivered order (`AOV`) based on delivered-order payment values. |
| `order_fulfillment_time` | Average calendar days from purchase timestamp to customer delivery timestamp for delivered orders. |
| `revenue_by_category` | Delivered revenue segmented by `product_category_name`; used for category performance questions. |
| `customer_retention_rate` | Monthly cohort retention: percentage of month-N buyers who purchase again in month N+1. |

## What lives here

```
olist-copilot/
├── app/
│   ├── page.tsx          # Chat UI — question input, example prompts, results display
│   ├── layout.tsx        # Root layout with global styles
│   ├── globals.css       # Tailwind CSS base styles
│   └── api/
│       └── query/
│           └── route.ts  # POST /api/query — the full RAG pipeline
├── next.config.ts
├── package.json
└── tsconfig.json
```

## How the query pipeline works

Every question posted to `POST /api/query` goes through three stages:

**Step 1 — Semantic retrieval**
The question is sent to the Python embedding microservice (`http://embedding_service:8001/embed`), which returns a vector using the `all-MiniLM-L6-v2` model. That vector is used to query ChromaDB and retrieve the top-3 most relevant metric definitions from the semantic layer.

**Step 2 — SQL generation**
The retrieved metric definitions are injected into a prompt for **Gemini 2.5 Flash**. Gemini is instructed to generate one valid `SELECT` query using only the governed analytics views. If the question falls outside those views, it returns `OUTSIDE_SCOPE` instead of guessing.

**Step 3 — Natural language answer**
If SQL was generated, it is executed against PostgreSQL and up to 25 rows are returned. Those rows, plus the metric definitions, are passed back to Gemini to produce a clear, business-friendly answer grounded solely in the retrieved data.

## Environment variables

The API route reads the following variables at runtime. Set them in a `.env.local` file for local development, or pass them as Docker environment variables in production.

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://analytics:analytics@localhost:5433/olist` |
| `CHROMA_URL` | ChromaDB base URL | `http://localhost:9000` |
| `EMBEDDING_SERVICE_URL` | Embedding microservice base URL | `http://localhost:8001` |
| `GEMINI_API_KEY` | Google Gemini API key | `AIza...` |
| `DEMO_API_KEY` | Optional API key for `POST /api/query` (header `x-demo-key` or `Authorization: Bearer`) | `change_me` |
| `EMBEDDING_API_KEY` | Optional service key for embedding endpoint (header `x-embedding-api-key`) | `change_me_too` |

## Security defaults

- `POST /api/query` now includes request validation, in-memory rate limiting, SQL safety checks, and read-only SQL execution.
- If `DEMO_API_KEY` is set, requests must include that key.
- If `EMBEDDING_API_KEY` is set, the embedding microservice rejects unauthenticated calls.

## Local development

The backend services (PostgreSQL, ChromaDB, embedding service) must be running before starting the Next.js dev server. The easiest way is:

```bash
# From the project root — start all backend services
docker compose up -d postgres chromadb embedding_service
```

Then, inside this directory:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Running inside Docker

The root `docker-compose.yml` builds and runs this app as the `nextjs` service on port `3000`. No extra configuration is needed — all environment variables are injected by Compose.

```bash
# From the project root
docker compose up -d
```

## Key dependencies

| Package | Purpose |
|---|---|
| `next` 16 | Framework, App Router, server-side API routes |
| `react` 19 | UI rendering |
| `@google/generative-ai` | Gemini 2.5 Flash for SQL generation and answer synthesis |
| `chromadb` | Vector search client for semantic layer retrieval |
| `pg` | PostgreSQL client for executing generated SQL |
| `tailwindcss` 4 | Utility-first styling |

## UI Features

- **Example prompts** — one-click buttons for six representative questions, including one intentionally outside the semantic model to demonstrate the guardrail.
- **Grounded answer badge** — green `✓ GROUNDED ANSWER` when the question was answered from the governed metrics; amber `⚠ OUTSIDE SEMANTIC MODEL` when it was not.
- **SQL transparency** — the generated query is shown below the answer so users can inspect every claim.
- **Raw data table** — scrollable table of up to 25 result rows from PostgreSQL.
