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
  const collection = await client.getCollection({
    name: "semantic_layer",
    embeddingFunction: stubEmbeddingFn,
  });
  const results = await collection.query({
    queryEmbeddings: [queryVector],
    nResults: 3,
  });
  return results.documents[0] as string[];
}

async function callGemini(prompt: string): Promise<string> {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

export async function POST(req: NextRequest) {
  const { question } = await req.json();

  // Step 1: RAG retrieval – embed question, vector-search ChromaDB
  const context = await retrieveContext(question);

  // Step 2: Generate SQL
  const sqlPrompt = `You are a SQL generator for a PostgreSQL analytics warehouse.
Generate ONE valid SELECT query using ONLY these governed metric views:
${context.join("\n\n")}

Available views: analytics.total_revenue, analytics.active_customers,
analytics.conversion_rate, analytics.average_order_value,
analytics.order_fulfillment_time, analytics.revenue_by_category,
analytics.customer_retention_rate

If the question cannot be answered with these views, return exactly: OUTSIDE_SCOPE

Return ONLY the SQL query or OUTSIDE_SCOPE. No explanation, no markdown.

Question: ${question}`;

  const sql = (await callGemini(sqlPrompt)).trim();

  let sqlResult: Record<string, unknown>[] = [];
  let isOutsideScope = sql === "OUTSIDE_SCOPE";

  if (!isOutsideScope) {
    try {
      const res = await pool.query(sql);
      sqlResult = res.rows.slice(0, 25);
    } catch {
      isOutsideScope = true;
    }
  }

  // Step 3: Generate grounded natural-language answer
  const answerPrompt = isOutsideScope
    ? `The user asked: "${question}"
This question is outside the governed semantic model.
Politely explain that you can only answer using these 7 defined metrics:
total_revenue, active_customers, conversion_rate, average_order_value,
order_fulfillment_time, revenue_by_category, customer_retention_rate.
Suggest which metric might be closest to what they are looking for.`
    : `You are an analytics assistant. Answer ONLY using the governed metric definitions below.
Do not invent metrics or use definitions not listed.

GOVERNED METRICS:
${context.join("\n\n")}

DATA RESULTS:
${JSON.stringify(sqlResult, null, 2)}

Question: ${question}

Provide a clear business-friendly answer grounded in the data above.`;

  const answer = await callGemini(answerPrompt);

  return NextResponse.json({
    answer,
    sql: isOutsideScope ? null : sql,
    sqlResult,
    context,
    isOutsideScope,
  });
}
