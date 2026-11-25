import { describe, it, expect, vi, beforeEach } from "vitest";

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
const http = vi.hoisted(() => ({ fail: false }));

vi.mock("@/config", () => ({ config: { logLevel: "silent", whatsapp: { apiBase: "https://graph.test", accessToken: "t" } } }));
vi.mock("@/utils/logger", () => {
  const rec = (level: string) => (message: string, context?: unknown) => void logs.lines.push(`${level} ${message} ${JSON.stringify(context ?? {})}`);
  return { createLogger: () => ({ info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") }) };
});
vi.mock("axios", () => ({
  default: {
    create: () => ({
      interceptors: { request: { use: () => undefined }, response: { use: () => undefined } },
      post: async () => {
        if (http.fail) throw Object.assign(new Error("boom"), { response: { data: { error: "nope" } } });
        return { data: { messages: [{ id: "wamid.1" }] } };
      },
    }),
  },
}));

import { whatsapp } from "@/services/whatsapp";

const FULL = "2349167582901";
const LOCAL = "09167582901";
beforeEach(() => {
  logs.lines.length = 0;
  http.fail = false;
});
const everything = () => logs.lines.join("\n");

describe("phone numbers in the WhatsApp logs", () => {
  it("a successful send logs only the last four digits", async () => {
    await whatsapp.sendTextMessage(FULL, "hi");
    expect(everything()).toContain("****2901");
    expect(everything()).not.toContain(FULL);
    expect(everything()).not.toContain(LOCAL);
  });

  it("every kind of send is masked: text, buttons and list", async () => {
    await whatsapp.sendTextMessage(LOCAL, "hi");
    await whatsapp.sendButtonsMessage(LOCAL, "pick", [{ id: "a", title: "A" }]);
    await whatsapp.sendListMessage(LOCAL, "pick", "Choose", [{ title: "s", rows: [{ id: "r", title: "R" }] }] as any);
    expect(logs.lines.filter((l) => l.startsWith("info")).length).toBeGreaterThanOrEqual(3);
    expect(everything()).not.toContain(LOCAL);
    expect(everything()).not.toContain("9167582901");
  });

  it("a failed send names the recipient only by its last four digits", async () => {
    http.fail = true;
    expect(await whatsapp.sendTextMessage(FULL, "hi")).toBe(false);
    expect(logs.lines.some((l) => l.startsWith("error"))).toBe(true);
    expect(everything()).toContain("****2901");
    expect(everything()).not.toContain(FULL);
  });
});
