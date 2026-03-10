import { NextRequest, NextResponse } from "next/server";
import { ChromaClient } from "chromadb";
import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

const MAX_QUESTION_CHARS = 500;
const MAX_SQL_CHARS = 4000;
const MAX_SQL_ROWS = 25;
const SQL_TIMEOUT_MS = 5000;
const EMBEDDING_TIMEOUT_MS = 8000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const DEMO_API_KEY = process.env.DEMO_API_KEY ?? "";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? "";

const REQUIRED_VIEWS = [
  "analytics.total_revenue",
  "analytics.active_customers",
  "analytics.conversion_rate",
  "analytics.average_order_value",
  "analytics.order_fulfillment_time",
  "analytics.revenue_by_category",
  "analytics.customer_retention_rate",
] as const;

const REQUIRED_VIEWS_SET = new Set(REQUIRED_VIEWS);

const FORBIDDEN_SQL_TERMS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "create",
  "grant",
  "revoke",
  "comment",
  "copy",
  "call",
  "do",
  "execute",
  "prepare",
  "deallocate",
  "vacuum",
  "analyze",
  "refresh",
  "set",
  "show",
  "pg_sleep",
];

const SUSPICIOUS_PROMPT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s+prompt/i,
  /developer\s+message/i,
  /jailbreak/i,
  /bypass\s+guardrails/i,
  /return\s+the\s+full\s+database/i,
];

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitStore = new Map<string, RateLimitEntry>();

// Module-level singletons – reused across warm invocations
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

function getClientId(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

function enforceRateLimit(clientId: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(clientId);

  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count += 1;
  rateLimitStore.set(clientId, entry);
  return true;
}

function cleanupRateLimitStore(): void {
  if (rateLimitStore.size < 2000) return;
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt <= now) rateLimitStore.delete(key);
  }
}

function isAuthorized(req: NextRequest): boolean {
  if (!DEMO_API_KEY) return true;
  const keyHeader = req.headers.get("x-demo-key")?.trim() ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return keyHeader === DEMO_API_KEY || bearer === DEMO_API_KEY;
}

function isLikelyPromptInjection(question: string): boolean {
  return SUSPICIOUS_PROMPT_PATTERNS.some((pattern) => pattern.test(question));
}

function cleanSql(sql: string): string {
  return sql
    .replace(/^```(?:sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function validateSql(sql: string): { ok: boolean; reason?: string } {
  const trimmed = cleanSql(sql);

  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_SQL_CHARS) return { ok: false, reason: "too_long" };
  if (trimmed.includes(";")) return { ok: false, reason: "semicolon_blocked" };

  const startsReadOnly = /^\s*(select|with)\b/i.test(trimmed);
  if (!startsReadOnly) return { ok: false, reason: "not_select" };

  const hasForbiddenKeyword = FORBIDDEN_SQL_TERMS.some((term) =>
    new RegExp(`\\b${term}\\b`, "i").test(trimmed),
  );
  if (hasForbiddenKeyword) return { ok: false, reason: "forbidden_keyword" };
  if (/\b(pg_catalog|information_schema|pg_)\b/i.test(trimmed)) {
    return { ok: false, reason: "system_schema_blocked" };
  }

  const viewMatches = Array.from(trimmed.matchAll(/analytics\.[a-z_]+/gi)).map((m) =>
    m[0].toLowerCase(),
  );

  for (const view of viewMatches) {
    if (!REQUIRED_VIEWS_SET.has(view as (typeof REQUIRED_VIEWS)[number])) {
      return { ok: false, reason: "non_governed_view" };
    }
  }

  return { ok: true };
}

async function executeReadOnlySql(sql: string): Promise<Record<string, unknown>[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${SQL_TIMEOUT_MS}ms'`);
    const result = await client.query(cleanSql(sql));
    await client.query("COMMIT");
    return result.rows.slice(0, MAX_SQL_ROWS);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Embed the question using the Python embedding microservice (scripts/embedding_service.py).
 * This uses the same all-MiniLM-L6-v2 model as embed_semantic_layer.py, guaranteeing
 * the query vector is in the same space as the stored ChromaDB embeddings.
 */
async function embedQuestion(question: string): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (EMBEDDING_API_KEY) headers["x-embedding-api-key"] = EMBEDDING_API_KEY;

  const res = await fetch(`${process.env.EMBEDDING_SERVICE_URL}/embed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: question }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) throw new Error(`Embedding service error: ${res.status}`);
  const { embedding } = await res.json();
  return embedding as number[];
}

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

  const safety = validateSql(sql);
  if (!safety.ok) {
    console.warn("[query] Blocked unsafe SQL:", safety.reason, "\nSQL:", sql);
    return { sql: "BLOCKED_UNSAFE_SQL", sqlResult: [], isOutsideScope: true };
  }

  try {
    const sqlResult = await executeReadOnlySql(sql);
    return { sql: cleanSql(sql), sqlResult, isOutsideScope: false };
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
    const fallbackSafety = validateSql(fallbackSql);
    if (!fallbackSafety.ok) {
      console.warn("[query] Blocked unsafe fallback SQL:", fallbackSafety.reason, "\nSQL:", fallbackSql);
      return retrySqlAfterFailure(sql, originalError);
    }

    try {
      const fallbackResult = await executeReadOnlySql(fallbackSql);
      return {
        sql: cleanSql(fallbackSql),
        sqlResult: fallbackResult,
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
  retrySql = cleanSql(retrySql);
  const retrySafety = validateSql(retrySql);
  if (!retrySafety.ok) {
    console.warn("[query] Blocked unsafe retry SQL:", retrySafety.reason, "\nSQL:", retrySql);
    return { sql: "BLOCKED_UNSAFE_SQL", sqlResult: [], isOutsideScope: true };
  }

  try {
    const retryResult = await executeReadOnlySql(retrySql);
    return {
      sql: retrySql,
      sqlResult: retryResult,
      isOutsideScope: false,
    };
  } catch (retryErr: unknown) {
    const errMsg2 = retryErr instanceof Error ? retryErr.message : String(retryErr);
    console.error("[query] SQL retry also failed:", errMsg2, "\nSQL:", retrySql);
    return { sql: retrySql, sqlResult: [], isOutsideScope: true };
  }
}

export async function POST(req: NextRequest) {
  cleanupRateLimitStore();

  if (!isAuthorized(req)) {
    return NextResponse.json({ answer: "Unauthorized", isOutsideScope: true }, { status: 401 });
  }

  const clientId = getClientId(req);
  if (!enforceRateLimit(clientId)) {
    return NextResponse.json(
      { answer: "Rate limit exceeded. Please wait a minute and retry.", isOutsideScope: true },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json(
      { answer: "Invalid request: question is required.", isOutsideScope: true },
      { status: 400 },
    );
  }

  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      {
        answer: `Question too long. Limit is ${MAX_QUESTION_CHARS} characters.`,
        isOutsideScope: true,
      },
      { status: 400 },
    );
  }

  if (isLikelyPromptInjection(question)) {
    return NextResponse.json(
      {
        answer: "Question rejected due to unsafe instruction pattern. Please rephrase as a business analytics query.",
        isOutsideScope: true,
      },
      { status: 400 },
    );
  }

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
    console.error("[query] Semantic retrieval failed:", msg);
    return NextResponse.json({
      answer: "Semantic retrieval is temporarily unavailable. Please retry shortly.",
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
  sql = cleanSql(sql);

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
    sql: isOutsideScope ? null : cleanSql(sql),
    sqlResult,
    context,
    isOutsideScope,
  });
}
