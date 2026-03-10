import { NextRequest, NextResponse } from "next/server";
import { ChromaClient } from "chromadb";
import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Module-level singletons – reused across warm invocations
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

/**
 * Embed the question using the Python embedding microservice (scripts/embedding_service.py).
 * This uses the same all-MiniLM-L6-v2 model as embed_semantic_layer.py, guaranteeing
 * the query vector is in the same space as the stored ChromaDB embeddings.
 */
async function embedQuestion(question: string): Promise<number[]> {
  const res = await fetch(`${process.env.EMBEDDING_SERVICE_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: question }),
  });
  if (!res.ok) throw new Error(`Embedding service error: ${res.status}`);
  const { embedding } = await res.json();
  return embedding as number[];
}

/**
 * True RAG retrieval: embed the question, then query ChromaDB with the raw
 * vector so the lookup uses the same embedding space as ingestion.
 */
/**
 * True RAG retrieval: embed the question, then query ChromaDB with the raw
 * vector so the lookup uses the same embedding space as ingestion.
 */
// Stub embedding function – we always supply raw vectors, so this is never called.
// Providing it prevents chromadb from trying to load @chroma-core/default-embed.
const stubEmbeddingFn = {
  generate: async (_texts: string[]): Promise<number[][]> => {
    throw new Error("Stub embedding function must not be called");
  },
};

async function retrieveContext(question: string): Promise<string[]> {
  const queryVector = await embedQuestion(question);
  // CHROMA_URL is http://localhost:9000 – host port 9000 → container 8000
  const chromaUrl = new URL(process.env.CHROMA_URL!);
  const client = new ChromaClient({
    ssl: chromaUrl.protocol === "https:",
    host: chromaUrl.hostname,
    port: Number(chromaUrl.port) || (chromaUrl.protocol === "https:" ? 443 : 80),
  });
  try {
    const collection = await client.getCollection({
      name: "semantic_layer",
      embeddingFunction: stubEmbeddingFn,
    });
    const results = await collection.query({
      queryEmbeddings: [queryVector],
      nResults: 3,
    });
    return results.documents[0] as string[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("defaultembeddingfunction")) {
      throw new Error(
        "Chroma collection was created with default-embed metadata. Rebuild semantic_layer via `python scripts/embed_semantic_layer.py` and restart the app.",
      );
    }
    throw err;
  }
}

async function callGemini(prompt: string): Promise<string> {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

const REQUIRED_VIEWS = [
  "analytics.total_revenue",
  "analytics.active_customers",
  "analytics.conversion_rate",
  "analytics.average_order_value",
  "analytics.order_fulfillment_time",
  "analytics.revenue_by_category",
  "analytics.customer_retention_rate",
];

async function getMissingViews(): Promise<string[]> {
  const missing: string[] = [];
  for (const view of REQUIRED_VIEWS) {
    const check = await pool.query("SELECT to_regclass($1) AS reg", [view]);
    if (!check.rows[0]?.reg) missing.push(view);
  }
  return missing;
}

function buildFallbackSql(question: string): string | null {
  const q = question.toLowerCase();
  const years = Array.from(new Set((q.match(/\b(20\d{2})\b/g) ?? []).map(Number))).sort(
    (a, b) => a - b,
  );

  if (/\btotal\s+revenue\b/.test(q) && years.length >= 2) {
    const yearList = years.join(", ");
    return `SELECT
  EXTRACT(YEAR FROM month)::INT AS year,
  ROUND(SUM(total_revenue)::NUMERIC, 2) AS total_revenue
FROM analytics.total_revenue
WHERE EXTRACT(YEAR FROM month) IN (${yearList})
GROUP BY 1
ORDER BY 1;`;
  }

  if (
    /\bhighest\b/.test(q) &&
    /(\baov\b|average order value)/.test(q) &&
    /\bcategory\b/.test(q)
  ) {
    return `SELECT
  product_category,
  ROUND(AVG(avg_order_value)::NUMERIC, 2) AS average_order_value
FROM analytics.average_order_value
GROUP BY 1
ORDER BY 2 DESC
LIMIT 1;`;
  }

  if (/\bconversion\s+rate\b/.test(q) && /(\bmonthly\b|trend)/.test(q)) {
    return `SELECT
  month,
  conversion_rate_pct
FROM analytics.conversion_rate
ORDER BY month;`;
  }

  if (/\bslowest\b/.test(q) && /(\bfulfillment\b|\bdelivery\b)/.test(q) && /\bstates?\b/.test(q)) {
    return `SELECT
  customer_state,
  ROUND(AVG(avg_fulfillment_days)::NUMERIC, 2) AS avg_fulfillment_days
FROM analytics.order_fulfillment_time
GROUP BY 1
ORDER BY 2 DESC;`;
  }

  if (/\bcustomer\s+retention\s+rate\b/.test(q) && /\bmonth\b/.test(q)) {
    return `SELECT
  month,
  retention_rate_pct
FROM analytics.customer_retention_rate
ORDER BY month;`;
  }

  return null;
}

function buildSqlPrompt(question: string, context: string[]): string {
  return `You are a SQL generator for a PostgreSQL analytics warehouse.
Generate ONE valid SELECT query using ONLY these governed metric views:
${context.join("\n\n")}

Available views and their columns:
- analytics.total_revenue (month TIMESTAMP, customer_state TEXT, product_category TEXT, total_revenue NUMERIC)
- analytics.active_customers (month TIMESTAMP, customer_state TEXT, active_customers BIGINT)
- analytics.conversion_rate (month TIMESTAMP, total_orders BIGINT, delivered_orders BIGINT, conversion_rate_pct NUMERIC)
- analytics.average_order_value (month TIMESTAMP, product_category TEXT, avg_order_value NUMERIC)
- analytics.order_fulfillment_time (month TIMESTAMP, customer_state TEXT, avg_fulfillment_days NUMERIC)
- analytics.revenue_by_category (month TIMESTAMP, product_category TEXT, category_revenue NUMERIC, order_count BIGINT)
- analytics.customer_retention_rate (month TIMESTAMP, cohort_size BIGINT, retained_next_month BIGINT, retention_rate_pct NUMERIC)

Rules:
- The "month" column is a TIMESTAMP truncated to the first day of each month.
- To filter by year use: EXTRACT(YEAR FROM month) = <year>
- To compare across years, group by EXTRACT(YEAR FROM month).
- If the question cannot be answered with these views, return exactly: OUTSIDE_SCOPE

Return ONLY the raw SQL query or OUTSIDE_SCOPE. No explanation, no markdown fences.

Question: ${question}`;
}

function buildGroundedAnswerPrompt(
  question: string,
  context: string[],
  sqlResult: Record<string, unknown>[],
): string {
  return `You are an analytics assistant. Answer ONLY using the governed metric definitions below.
Do not invent metrics or use definitions not listed.

GOVERNED METRICS:
${context.join("\n\n")}

DATA RESULTS:
${JSON.stringify(sqlResult, null, 2)}

Question: ${question}

Provide a clear business-friendly answer grounded in the data above.`;
}

type SqlExecution = {
  sql: string;
  sqlResult: Record<string, unknown>[];
  isOutsideScope: boolean;
};

async function runSql(initialSql: string, fallbackSql: string | null): Promise<SqlExecution> {
  let sql = initialSql;
  let isOutsideScope = sql.toUpperCase().includes("OUTSIDE_SCOPE");

  if (isOutsideScope && fallbackSql) {
    sql = fallbackSql;
    isOutsideScope = false;
  }

  if (isOutsideScope) {
    return { sql, sqlResult: [], isOutsideScope: true };
  }

  try {
    const res = await pool.query(sql);
    return { sql, sqlResult: res.rows.slice(0, 25), isOutsideScope: false };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[query] SQL failed, retrying:", errMsg, "\nSQL:", sql);
    return retryWithFallbackOrGemini(sql, fallbackSql, errMsg);
  }
}

async function retryWithFallbackOrGemini(
  sql: string,
  fallbackSql: string | null,
  originalError: string,
): Promise<SqlExecution> {
  if (fallbackSql && fallbackSql !== sql) {
    try {
      const fallbackRes = await pool.query(fallbackSql);
      return {
        sql: fallbackSql,
        sqlResult: fallbackRes.rows.slice(0, 25),
        isOutsideScope: false,
      };
    } catch (fallbackErr: unknown) {
      const fallbackErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.error("[query] Fallback SQL failed:", fallbackErrMsg, "\nSQL:", fallbackSql);
    }
  }
  return retrySqlAfterFailure(sql, originalError);
}

async function retrySqlAfterFailure(sql: string, originalError: string): Promise<SqlExecution> {
  const retryPrompt = `The following SQL query failed with this error:
Error: ${originalError}
Query: ${sql}

Fix the query using ONLY these views and columns:
- analytics.total_revenue (month TIMESTAMP, customer_state TEXT, product_category TEXT, total_revenue NUMERIC)
- analytics.active_customers (month TIMESTAMP, customer_state TEXT, active_customers BIGINT)
- analytics.conversion_rate (month TIMESTAMP, total_orders BIGINT, delivered_orders BIGINT, conversion_rate_pct NUMERIC)
- analytics.average_order_value (month TIMESTAMP, product_category TEXT, avg_order_value NUMERIC)
- analytics.order_fulfillment_time (month TIMESTAMP, customer_state TEXT, avg_fulfillment_days NUMERIC)
- analytics.revenue_by_category (month TIMESTAMP, product_category TEXT, category_revenue NUMERIC, order_count BIGINT)
- analytics.customer_retention_rate (month TIMESTAMP, cohort_size BIGINT, retained_next_month BIGINT, retention_rate_pct NUMERIC)

Return ONLY the corrected SQL. No explanation, no markdown fences.`;

  let retrySql = (await callGemini(retryPrompt)).trim();
  retrySql = retrySql.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const res2 = await pool.query(retrySql);
    return {
      sql: retrySql,
      sqlResult: res2.rows.slice(0, 25),
      isOutsideScope: false,
    };
  } catch (retryErr: unknown) {
    const errMsg2 = retryErr instanceof Error ? retryErr.message : String(retryErr);
    console.error("[query] SQL retry also failed:", errMsg2, "\nSQL:", retrySql);
    return { sql: retrySql, sqlResult: [], isOutsideScope: true };
  }
}

export async function POST(req: NextRequest) {
  const { question } = await req.json();
  const fallbackSql = buildFallbackSql(question);

  // Infrastructure guardrail: this is a setup issue, not an out-of-scope question.
  const missingViews = await getMissingViews();
  if (missingViews.length > 0) {
    return NextResponse.json({
      answer: `The analytics warehouse is not initialized. Missing views: ${missingViews.join(", ")}. Run \`python scripts/load_data.py\` from the project root, then retry.`,
      sql: null,
      sqlResult: [],
      context: [],
      isOutsideScope: true,
    });
  }

  // Step 1: RAG retrieval – embed question, vector-search ChromaDB
  let context: string[] = [];
  try {
    context = await retrieveContext(question);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      answer: `Semantic retrieval is unavailable: ${msg}`,
      sql: null,
      sqlResult: [],
      context: [],
      isOutsideScope: true,
    });
  }

  // Step 2: Generate SQL
  const sqlPrompt = buildSqlPrompt(question, context);

  let sql = (await callGemini(sqlPrompt)).trim();
  // Strip markdown code fences if present (e.g. ```sql ... ```)
  sql = sql.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const execution = await runSql(sql, fallbackSql);
  sql = execution.sql;
  const sqlResult = execution.sqlResult;
  const isOutsideScope = execution.isOutsideScope;

  // Step 3: Generate grounded natural-language answer
  const answerPrompt = isOutsideScope
    ? `The user asked: "${question}"
This question is outside the governed semantic model.
Politely explain that you can only answer using these 7 defined metrics:
total_revenue, active_customers, conversion_rate, average_order_value,
order_fulfillment_time, revenue_by_category, customer_retention_rate.
Suggest which metric might be closest to what they are looking for.`
    : buildGroundedAnswerPrompt(question, context, sqlResult);

  const answer = await callGemini(answerPrompt);

  return NextResponse.json({
    answer,
    sql: isOutsideScope ? null : sql,
    sqlResult,
    context,
    isOutsideScope,
  });
}
