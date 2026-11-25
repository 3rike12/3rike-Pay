import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { createLogger } from "@/utils/logger";

const logger = createLogger("agent-memory");

// ============================================
// The stock agent's conversation memory
//
// LangGraph's own mechanism: a checkpointer that saves the conversation under a THREAD id. One thread per person
// means one memory per person, kept by the framework, not by us.
//
// Isolation, which is the point:
//   - THE THREAD ID IS BUILT FROM ONE THING: the internal user id of whoever sent the WhatsApp message (never text a
//     person typed). `stock:<id>`. An id that does not look like one (empty, short, containing ":" "*" or spaces) gets
//     NO thread: the caller must treat it as having no memory.
//   - EVERY RUN NAMES ITS THREAD. The agent is built for each request with that person's tools and thread; nothing
//     is shared between people but the saver, and the saver only ever returns the thread it is asked for.
//   - IT FORGETS. A conversation quiet for 30 minutes is deleted before the next turn, so a new topic starts clean,
//     and `purgeIdle` removes abandoned threads from the database.
//
// Storage: Postgres (a database used ONLY for this, in its own container: see docker-compose.yml) when AGENT_DB_URL is
// set; otherwise LangGraph's in-memory saver, which keeps nothing on disk and forgets on restart. If Postgres cannot
// be reached the app falls back to in-memory rather than failing a customer's question.
// ============================================

export const THREAD_PREFIX = "stock:";
const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** The thread for a person, or null if the id is not one we would have issued. */
export function threadIdFor(userId: string): string | null {
  return typeof userId === "string" && SAFE_ID.test(userId) ? `${THREAD_PREFIX}${userId}` : null;
}

export interface AgentMemory {
  checkpointer: BaseCheckpointSaver;
  kind: "postgres" | "memory";
  /**
   * The thread to use for this person right now: theirs, cleared first if the conversation had gone quiet. Null when the
   * id is not usable, in which case the caller runs without memory.
   */
  threadFor(userId: string): Promise<string | null>;
  /** Delete threads idle longer than this. Returns how many. */
  purgeIdle(hours: number): Promise<number>;
  close(): Promise<void>;
}

export interface AgentMemoryOptions {
  /** Postgres connection string for the memory database. Empty means in-memory. */
  connectionString?: string;
  /** How many times to try reaching the database before using in-memory instead. Default 10. */
  connectAttempts?: number;
  /** Wait between tries. Default 2 seconds. A fresh database container can take a few seconds to accept connections. */
  retryDelayMs?: number;
  /** Replaceable so a test can stand in for the database. */
  connect?: (connectionString: string) => Promise<{ saver: BaseCheckpointSaver; pool: Pool }>;
  /** How long a conversation may be quiet before the next message starts a new one. Default 30 minutes. */
  idleMs?: number;
  now?: () => number;
}

export async function createAgentMemory(options: AgentMemoryOptions = {}): Promise<AgentMemory> {
  const idleMs = options.idleMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;

  let saver: BaseCheckpointSaver = new MemorySaver();
  let kind: AgentMemory["kind"] = "memory";
  let pool: Pool | null = null;

  if (options.connectionString) {
    const attempts = Math.max(1, options.connectAttempts ?? 10);
    const delay = options.retryDelayMs ?? 2000;
    const connect =
      options.connect ??
      (async (url: string) => {
        const p = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
        try {
          const pg = new PostgresSaver(p);
          await pg.setup(); // creates its tables in this database (and only this one) on first use
          return { saver: pg as BaseCheckpointSaver, pool: p };
        } catch (error) {
          await p.end().catch(() => undefined);
          throw error;
        }
      });
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const c = await connect(options.connectionString);
        saver = c.saver;
        pool = c.pool;
        kind = "postgres";
        logger.info("Agent memory is using its own Postgres database", { attempt });
        break;
      } catch (error: any) {
        if (attempt === attempts) logger.error("Agent memory could not reach its Postgres database; using in-memory instead", { error: error?.message, attempts });
        else await new Promise((r) => setTimeout(r, delay));
      }
    }
  } else {
    logger.info("Agent memory is in-memory (AGENT_DB_URL is not set): conversations are forgotten on restart");
  }

  return {
    checkpointer: saver,
    kind,

    async threadFor(userId) {
      const thread = threadIdFor(userId);
      if (!thread) return null;
      try {
        const tuple = await saver.getTuple({ configurable: { thread_id: thread } });
        const ts = tuple ? Date.parse((tuple.checkpoint as { ts?: string }).ts ?? "") : NaN;
        if (tuple && Number.isFinite(ts) && now() - ts > idleMs) await saver.deleteThread(thread);
      } catch (error: any) {
        logger.warn("Could not check a conversation's age", { error: error?.message });
      }
      return thread;
    },

    async purgeIdle(hours) {
      if (!pool) return 0; // in-memory threads are cleared when their owner comes back, and all of them on restart
      try {
        const { rows } = await pool.query(
          `SELECT thread_id FROM checkpoints WHERE thread_id LIKE $1
           GROUP BY thread_id HAVING MAX((checkpoint->>'ts')::timestamptz) < now() - ($2 || ' hours')::interval`,
          [`${THREAD_PREFIX}%`, String(hours)]
        );
        for (const r of rows) await saver.deleteThread(r.thread_id);
        if (rows.length) logger.info("Purged idle agent conversations", { count: rows.length });
        return rows.length;
      } catch (error: any) {
        logger.warn("Could not purge idle agent conversations", { error: error?.message });
        return 0;
      }
    },

    async close() {
      await pool?.end().catch(() => undefined);
    },
  };
}
