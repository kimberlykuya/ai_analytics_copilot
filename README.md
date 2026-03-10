# AI Analytics Copilot

A natural-language analytics assistant built on the [Olist Brazilian e-commerce dataset](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce). Ask plain-English business questions and receive SQL-backed, hallucination-guarded answers — all powered by a governed semantic layer, vector search, and Google Gemini.

## What it does

You type a question like *"Which product category has the highest average order value?"* and the system:

1. Embeds your question into a vector and retrieves the most relevant metric definitions from ChromaDB.
2. Feeds those definitions to Gemini 2.5 Flash, which generates a precise SQL query.
3. Runs that SQL against a PostgreSQL analytics warehouse.
4. Sends the results back to Gemini, which writes a clear, business-friendly answer.
5. Returns the answer, the SQL, and the raw data rows to the browser.

Questions outside the seven governed metrics are politely declined rather than answered with a hallucinated response.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser (Next.js)               │
│         Natural-language question input          │
└───────────────────┬─────────────────────────────┘
                    │  POST /api/query
┌───────────────────▼─────────────────────────────┐
│              Next.js API Route                   │
│  1. Embed question  ──► Embedding Service :8001  │
│  2. Vector search   ──► ChromaDB         :9000   │
│  3. Generate SQL    ──► Gemini 2.5 Flash          │
│  4. Execute SQL     ──► PostgreSQL        :5433   │
│  5. Generate answer ──► Gemini 2.5 Flash          │
└─────────────────────────────────────────────────┘

 ┌──────────────────┐  ┌────────────────────────┐
 │  load_data.py    │  │  embed_semantic_layer  │
 │  CSV → raw →     │  │  Metric defs → vectors │
 │  analytics views │  │  → ChromaDB            │
 └──────────────────┘  └────────────────────────┘
```

### Services (Docker Compose)

| Service | Port | Description |
|---|---|---|
| `postgres` | 5433 | Analytics warehouse (raw + analytics schemas) |
| `chromadb` | 9000 | Vector store for the semantic layer |
| `embedding_service` | 8001 | FastAPI microservice — `all-MiniLM-L6-v2` embeddings |
| `nextjs` | 3000 | Chat UI + API routes |

---

## Repository Structure

```
├── data/                        # Olist CSV source files
├── models/
│   ├── intermediate/            # Reusable intermediate SQL views
│   │   ├── products.sql
│   │   └── sellers.sql
│   └── metrics/                 # The 7 governed metric views
│       ├── total_revenue.sql
│       ├── active_customers.sql
│       ├── conversion_rate.sql
│       ├── average_order_value.sql
│       ├── order_fulfillment_time.sql
│       ├── revenue_by_category.sql
│       └── customer_retention_rate.sql
├── scripts/                     # Python ETL + embedding pipeline
│   ├── load_data.py             # CSV → PostgreSQL + build analytics views
│   ├── embed_semantic_layer.py  # Metric defs → ChromaDB
│   └── embedding_service.py    # FastAPI embedding microservice
├── olist-copilot/               # Next.js 16 frontend
├── docker-compose.yml
├── Dockerfile.embedding
└── requirements.txt
```

---

## Governed Metrics

All answers are grounded in exactly **seven** pre-defined metric views. Nothing outside these views is queried.

| Metric | Description |
|---|---|
| `total_revenue` | Total payment value from delivered orders |
| `active_customers` | Unique customers with at least one delivered order |
| `conversion_rate` | % of created orders that reach delivered status |
| `average_order_value` | Average revenue per delivered order (AOV) |
| `order_fulfillment_time` | Avg calendar days from purchase to delivery |
| `revenue_by_category` | Delivered revenue segmented by product category |
| `customer_retention_rate` | % of month-N buyers who also bought in month N+1 |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- A `.env` file in the project root (see below)
- A Google Gemini API key

### 1. Create `.env`

```env
POSTGRES_USER=analytics
POSTGRES_PASSWORD=analytics
POSTGRES_DB=olist
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5433
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. Start all services

```bash
docker compose up -d
```

### 3. Run the ETL pipeline

Loads the Olist CSVs into PostgreSQL and builds all analytics views:

```bash
pip install -r requirements.txt
python scripts/load_data.py
```

### 4. Embed the semantic layer

Vectorises the metric definitions and upserts them into ChromaDB:

```bash
python scripts/embed_semantic_layer.py
```

### 5. Open the UI

Navigate to [http://localhost:3000](http://localhost:3000).

> For local frontend development see [`olist-copilot/README.md`](olist-copilot/README.md).
> For details on the Python scripts see [`scripts/README.md`](scripts/README.md).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Warehouse | PostgreSQL 16 |
| Vector store | ChromaDB |
| Embedding model | `all-MiniLM-L6-v2` (sentence-transformers) |
| LLM | Google Gemini 2.5 Flash |
| Embedding API | FastAPI + Uvicorn |
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| ETL | Python, pandas, SQLAlchemy |
| Container runtime | Docker Compose |

## View Structure

```
PostgreSQL
├── raw (schema)
│   ├── raw_orders
│   ├── raw_order_items
│   ├── raw_customers
│   ├── raw_products
│   ├── raw_payments
│   ├── raw_sellers
│   ├── raw_order_reviews
│   └── raw_geolocation
│
└── analytics (schema)
    ├── total_revenue (metric)
    ├── active_customers (metric)
    ├── conversion_rate (metric)
    ├── average_order_value (metric)
    ├── order_fulfillment_time (metric)
    ├── revenue_by_category (metric)
    ├── customer_retention_rate (metric)
    ├── sellers (intermediate)
    └── products (intermediate)
```

## Advantages over dbt

✓ **Works with Python 3.14** (no compatibility issues)
✓ **Simpler setup** (no profiles.yml, no dbt CLI issues)
✓ **Full Python control** (can add custom transformations)
✓ **Easier debugging** (standard Python stack traces)
✓ **Can call from other Python code** (notebooks, APIs, etc.)

## Next Steps

1. Add Great Expectations for data quality tests
2. Create orchestration with Airflow/Prefect
3. Add more intermediate models
4. Create business metric calculations
