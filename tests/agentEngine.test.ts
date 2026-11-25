import { describe, it, expect, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

import { resolveAgentEngine } from "@/services/agent/engine";
import { createAgentMemory } from "@/services/agent/memory";

describe("which agent runs by default", () => {
  it("LangGraph, with nothing set", () => {
    expect(resolveAgentEngine(undefined)).toBe("langgraph");
    expect(resolveAgentEngine("")).toBe("langgraph");
  });

  it("the original agent only when asked for by name, in any case", () => {
    for (const v of ["custom", "CUSTOM", " Custom "]) expect(resolveAgentEngine(v)).toBe("custom");
  });

  it("anything unrecognised, including a typo, still means LangGraph rather than silently switching away", () => {
    for (const v of ["langgraph", "LangGraph", "lang-graph", "customm", "true", "0"]) expect(resolveAgentEngine(v)).toBe("langgraph");
  });
});

describe("the agent's memory database is given time to come up", () => {
  const fakePool = () => ({ query: async () => ({ rows: [] }), end: async () => undefined }) as any;
  const connectAfter = (failures: number) => {
    let calls = 0;
    const connect = vi.fn(async () => {
      if (++calls <= failures) throw new Error("the database system is starting up");
      return { saver: new MemorySaver(), pool: fakePool() };
    });
    return connect;
  };

  it("with no database configured it is in-memory, straight away, and never tries to connect", async () => {
    const connect = vi.fn();
    const m = await createAgentMemory({ connect: connect as any });
    expect(m.kind).toBe("memory");
    expect(connect).not.toHaveBeenCalled();
  });

  it("a database that is ready first time is used", async () => {
    const connect = connectAfter(0);
    const m = await createAgentMemory({ connectionString: "postgresql://x/y", connect, retryDelayMs: 0 });
    expect(m.kind).toBe("postgres");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a fresh database container that needs a few seconds is waited for, not abandoned", async () => {
    const connect = connectAfter(4); // refuses four times while it starts
    const m = await createAgentMemory({ connectionString: "postgresql://x/y", connect, retryDelayMs: 0 });
    expect(m.kind).toBe("postgres");
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it("one that never comes up falls back to in-memory after the tries run out, so questions still get answered", async () => {
    const connect = connectAfter(99);
    const m = await createAgentMemory({ connectionString: "postgresql://x/y", connect, connectAttempts: 3, retryDelayMs: 0 });
    expect(m.kind).toBe("memory");
    expect(connect).toHaveBeenCalledTimes(3);
    expect(await m.threadFor("user_aaaaaaaa-1111")).toBe("stock:user_aaaaaaaa-1111"); // and it still works
  });

  it("the tries are bounded: the wait cannot go on forever", async () => {
    const connect = connectAfter(99);
    await createAgentMemory({ connectionString: "postgresql://x/y", connect, retryDelayMs: 0 });
    expect(connect).toHaveBeenCalledTimes(10); // the default
  });
});
