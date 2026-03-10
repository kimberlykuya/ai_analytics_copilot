# olist-copilot — Next.js Frontend

The chat interface and API layer for the AI Analytics Copilot. Users type natural-language business questions; the app runs a three-step RAG pipeline and returns a grounded, data-backed answer.

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
