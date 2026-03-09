"use client";
import { useState } from "react";

const EXAMPLES = [
  "What was total revenue in 2017 vs 2018?",
  "Which product category has the highest AOV?",
  "What is our monthly conversion rate trend?",
  "Which states have the slowest fulfillment time?",
  "Show customer retention rate by month",
  "What is our profit margin by region?", // outside scope example
];

interface QueryResult {
  answer: string;
  sql: string | null;
  sqlResult: Record<string, unknown>[];
  context: string[];
  isOutsideScope: boolean;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(q?: string) {
    const q2 = q ?? question;
    if (!q2.trim()) return;
    setQuestion(q2);
    setLoading(true);
    setResult(null);
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q2 }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-mono">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics Copilot</h1>
          <p className="text-slate-400 text-sm mt-1">
            Governed semantic layer · 7 defined metrics · Hallucination guardrails
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => ask(e)}
              className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-full transition-colors"
            >
              {e}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="Ask a business question..."
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm outline-none focus:border-blue-500"
          />
          <button
            onClick={() => ask()}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-5 py-3 rounded-lg text-sm font-bold transition-colors"
          >
            {loading ? "..." : "Ask"}
          </button>
        </div>

        {result && (
          <div className="space-y-3">
            <div
              className={`rounded-xl p-5 border ${
                result.isOutsideScope
                  ? "bg-amber-950/40 border-amber-700/50"
                  : "bg-slate-800 border-slate-700"
              }`}
            >
              <div
                className={`text-xs font-bold mb-2 ${
                  result.isOutsideScope ? "text-amber-400" : "text-green-400"
                }`}
              >
                {result.isOutsideScope
                  ? "⚠ OUTSIDE SEMANTIC MODEL"
                  : "✓ GROUNDED ANSWER"}
              </div>
              <p className="text-sm leading-relaxed">{result.answer}</p>
            </div>

            {!result.isOutsideScope && (
              <>
                <details className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <summary className="text-xs text-blue-400 cursor-pointer">
                    SEMANTIC CONTEXT RETRIEVED
                  </summary>
                  <pre className="mt-3 text-xs text-slate-400 whitespace-pre-wrap">
                    {result.context?.join("\n\n---\n\n")}
                  </pre>
                </details>

                <details className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <summary className="text-xs text-yellow-400 cursor-pointer">
                    GENERATED SQL
                  </summary>
                  <pre className="mt-3 text-xs text-slate-300 overflow-x-auto">
                    {result.sql}
                  </pre>
                </details>

                {result.sqlResult?.length > 0 && (
                  <details className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                    <summary className="text-xs text-purple-400 cursor-pointer">
                      RAW DATA ({result.sqlResult.length} rows)
                    </summary>
                    <div className="mt-3 overflow-x-auto">
                      <table className="text-xs w-full">
                        <thead>
                          <tr>
                            {Object.keys(result.sqlResult[0]).map((k) => (
                              <th
                                key={k}
                                className="text-left px-2 py-1 text-slate-500 border-b border-slate-700"
                              >
                                {k}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {result.sqlResult.map((row, i) => (
                            <tr key={i} className="border-b border-slate-800/50">
                              {Object.values(row).map((v, j) => (
                                <td key={j} className="px-2 py-1">
                                  {String(v)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
