import { config } from "@/config";

// Does the model API support native tool calling? Sends one tiny request with a tool and prints the SHAPE of the
// reply (never the key). Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/probe-tools.ts
(async () => {
  const c: any = (config as any).llm;
  const body: any = {
    model: c.model,
    max_tokens: 3000,
    temperature: 0.2,
    ...(c.reasoningEffort ? { reasoning_effort: c.reasoningEffort } : {}),
    messages: [
      { role: "system", content: "You can call tools. Use them when you need data." },
      { role: "user", content: "What is the latest news for NVDA? Use the tool." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_news",
          description: "Recent news headlines for a stock ticker.",
          parameters: { type: "object", properties: { ticker: { type: "string", description: "e.g. NVDA" } }, required: ["ticker"] },
        },
      },
    ],
    tool_choice: "auto",
  };
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const j = JSON.parse(text);
    const ch = j?.choices?.[0];
    console.log("finish_reason:", ch?.finish_reason);
    console.log("content:", JSON.stringify(ch?.message?.content)?.slice(0, 200));
    console.log("tool_calls:", JSON.stringify(ch?.message?.tool_calls)?.slice(0, 400));
    if (j?.error) console.log("error:", JSON.stringify(j.error).slice(0, 300));
  } catch {
    console.log("not JSON:", text.slice(0, 300));
  }
  process.exit(0);
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
