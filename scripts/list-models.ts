/** List the model ids the configured key can use, and try the configured model. Prints no key. */
import { config } from "@/config";

(async () => {
  const c: any = (config as any).llm;
  const h = { Authorization: `Bearer ${c.apiKey}` };
  const r = await fetch(`${c.baseUrl}/models`, { headers: h, signal: AbortSignal.timeout(20_000) });
  console.log(`GET ${c.baseUrl}/models -> HTTP ${r.status}`);
  const j: any = await r.json().catch(() => null);
  const ids: string[] = (j?.data ?? []).map((m: any) => m.id);
  console.log(ids.length ? `models: ${ids.join(", ")}` : `body: ${JSON.stringify(j)?.slice(0, 300)}`);
  console.log(`configured model: ${c.model}  (${ids.includes(c.model) ? "listed" : "NOT in the list"})`);
  const t = await fetch(`${c.baseUrl}/chat/completions`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ model: c.model, max_tokens: 200, messages: [{ role: "user", content: "Say ok" }] }), signal: AbortSignal.timeout(30_000) });
  const tj: any = await t.json().catch(() => null);
  console.log(`chat with "${c.model}" -> HTTP ${t.status}${t.ok ? "" : " " + JSON.stringify(tj?.error ?? tj).slice(0, 250)}`);
  process.exit(0);
})().catch((e) => { console.log("Failed:", e?.message); process.exit(1); });
