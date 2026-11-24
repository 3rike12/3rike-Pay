import { config } from "@/config";

// Probe the model API's response SHAPE with a trivial prompt. Prints structure and short text, never the key.
(async () => {
  const c: any = (config as any).llm;
  const url = `${c.baseUrl}/chat/completions`;
  for (const maxTokens of [50, 700]) {
    const body: any = { model: c.model, messages: [{ role: "user", content: 'Reply with exactly: {"ok": true}' }], max_tokens: maxTokens, temperature: 0.2 };
    if (c.reasoningEffort) body.reasoning_effort = c.reasoningEffort;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    console.log(`--- max_tokens=${maxTokens}  HTTP ${res.status}  model=${c.model}`);
    try {
      const j = JSON.parse(text);
      const shape = (v: any, d = 0): any => (v && typeof v === "object" ? (Array.isArray(v) ? v.slice(0, 2).map((x) => shape(x, d + 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d > 3 ? typeof x : shape(x, d + 1)]))) : typeof v === "string" ? `string(${v.length}): ${v.slice(0, 80)}` : v);
      console.log(JSON.stringify(shape(j), null, 1).slice(0, 1500));
    } catch {
      console.log("not JSON:", text.slice(0, 300));
    }
  }
  process.exit(0);
})().catch((e) => { console.log("Failed:", e?.message); process.exit(1); });
