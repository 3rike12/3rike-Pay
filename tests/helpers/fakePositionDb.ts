// In-memory StockPosition + PositionEntry tables that behave like a real database
// under READ COMMITTED, so concurrency bugs show up in tests:
//
//  - Transactions are NOT serialised. Each statement applies immediately and every
//    read yields to other callers, so two transactions interleave between "read"
//    and "write". A read-then-write bug (set units = old + n) loses updates here,
//    exactly as it would in production; an atomic increment does not.
//  - A transaction that throws is rolled back by undoing ITS OWN changes in
//    reverse, never by restoring a snapshot (which would erase other
//    transactions' committed work).
//  - Unique violations throw Prisma's P2002; updateMany supports the conditional
//    `units >= n` guard, applied atomically.
//
// Every method takes an optional second argument { undo } that a transaction
// passes so its writes can be rolled back. Tests can spy on the shared methods
// (they are what transaction calls go through) and should forward that argument.
type Ctx = { undo?: Array<() => void> } | undefined;

export function makePositionDb() {
  const positions = new Map<string, any>();
  const entries: any[] = [];
  let n = 0;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: "P2002", meta: { target: [target] } });
  const byUnique = (w: any) => [...positions.values()].find((p) => p.userId === w.userId_tokenAddress.userId && p.tokenAddress === w.userId_tokenAddress.tokenAddress) ?? null;

  // Applies a data object and returns how to undo it (an inverse delta for increments, never an absolute restore).
  const apply = (p: any, data: any): (() => void) => {
    const { units, ...rest } = data;
    let undoUnits: (() => void) | null = null;
    if (units?.increment !== undefined) {
      p.units += units.increment;
      undoUnits = () => void (p.units -= units.increment);
    } else if (units?.decrement !== undefined) {
      p.units -= units.decrement;
      undoUnits = () => void (p.units += units.decrement);
    } else if (units !== undefined) {
      const before = p.units;
      p.units = units;
      undoUnits = () => void (p.units = before);
    }
    const before = { ...rest };
    for (const k of Object.keys(rest)) before[k] = p[k];
    Object.assign(p, rest);
    return () => {
      undoUnits?.();
      Object.assign(p, before);
    };
  };

  const api: any = {
    positions,
    get entries() {
      return entries;
    },
    stockPosition: {
      findUnique: async ({ where }: any, _ctx?: Ctx) => {
        await tick();
        const p = where.id ? positions.get(where.id) : byUnique(where);
        return p ? { ...p } : null;
      },
      findMany: async ({ where }: any = {}, _ctx?: Ctx) => {
        await tick();
        return [...positions.values()]
          .filter(
            (p) =>
              (!where?.userId || p.userId === where.userId) &&
              (!where?.tokenAddress || p.tokenAddress === where.tokenAddress) &&
              (where?.units?.gt === undefined || p.units > where.units.gt) &&
              (where?.units?.lt === undefined || p.units < where.units.lt)
          )
          .map((p) => ({ ...p }));
      },
      create: async ({ data }: any, ctx?: Ctx) => {
        await tick();
        if ([...positions.values()].some((p) => p.userId === data.userId && p.tokenAddress === data.tokenAddress)) throw uniqueError("userId_tokenAddress");
        const p = { id: `p${++n}`, ...data };
        positions.set(p.id, p);
        ctx?.undo?.push(() => void positions.delete(p.id));
        return { ...p };
      },
      update: async ({ where, data }: any, ctx?: Ctx) => {
        await tick();
        const p = positions.get(where.id);
        const undo = apply(p, data);
        ctx?.undo?.push(undo);
        return { ...p };
      },
      updateMany: async ({ where, data }: any, ctx?: Ctx) => {
        await tick();
        const p = positions.get(where.id);
        if (!p || (where.units?.gte !== undefined && !(p.units >= where.units.gte))) return { count: 0 };
        const undo = apply(p, data);
        ctx?.undo?.push(undo);
        return { count: 1 };
      },
      groupBy: async () => {
        const acc = new Map<string, bigint>();
        for (const p of positions.values()) acc.set(p.tokenAddress, (acc.get(p.tokenAddress) ?? 0n) + p.units);
        return [...acc.entries()].map(([tokenAddress, sum]) => ({ tokenAddress, _sum: { units: sum } }));
      },
    },
    positionEntry: {
      create: async ({ data }: any, ctx?: Ctx) => {
        await tick();
        if (data.idempotencyKey && entries.some((e) => e.idempotencyKey === data.idempotencyKey)) throw uniqueError("idempotencyKey");
        const e = { id: `pe${entries.length + 1}-${Math.random().toString(36).slice(2, 6)}`, idempotencyKey: null, ...data };
        entries.push(e);
        ctx?.undo?.push(() => void entries.splice(entries.indexOf(e), 1));
        return e;
      },
      findUnique: async ({ where }: any, _ctx?: Ctx) => {
        await tick();
        return entries.find((e) => e.idempotencyKey === where.idempotencyKey) ?? null;
      },
      findMany: async ({ where }: any = {}, _ctx?: Ctx) => {
        await tick();
        return entries.filter((e) => !where?.positionId || e.positionId === where.positionId);
      },
      groupBy: async () => {
        const acc = new Map<string, any>();
        for (const e of entries) {
          const k = `${e.positionId}|${e.direction}`;
          const row = acc.get(k) ?? { positionId: e.positionId, direction: e.direction, _sum: { units: 0n } };
          row._sum.units += e.units;
          acc.set(k, row);
        }
        return [...acc.values()];
      },
    },
    // A transaction object whose every call goes through the shared methods above, carrying its undo log.
    $transaction: async (fn: any) => {
      const ctx = { undo: [] as Array<() => void> };
      const via = (table: string, ...methods: string[]) =>
        Object.fromEntries(methods.map((m) => [m, (args: any) => api[table][m](args, ctx)]));
      const tx = {
        stockPosition: via("stockPosition", "findUnique", "findMany", "create", "update", "updateMany", "groupBy"),
        positionEntry: via("positionEntry", "create", "findUnique", "findMany"),
      };
      try {
        return await fn(tx);
      } catch (error) {
        for (const u of ctx.undo.reverse()) u();
        throw error;
      }
    },
    reset() {
      positions.clear();
      entries.length = 0;
      n = 0;
    },
  };
  return api;
}
