// An in-memory Wallet + LedgerEntry store that behaves like a real database under
// READ COMMITTED, so concurrency and rollback bugs show up in tests:
//
//  - Transactions are NOT serialised. Each statement applies immediately and every
//    read yields to other callers, so two transactions interleave between "read"
//    and "write": a read-then-write bug loses updates here, an atomic increment
//    does not.
//  - A transaction that throws is rolled back by undoing ITS OWN changes in
//    reverse (never a snapshot restore, which would erase other transactions' work).
//  - Unique constraints throw Prisma's P2002 (wallet userId+currency, entry
//    idempotencyKey). updateMany supports the conditional "balance >= n" guard,
//    applied atomically.
//
// Every method takes an optional second argument { undo } that a transaction
// passes so its writes can be rolled back. Tests can spy on the shared methods
// (transaction calls go through them) and should forward that argument.
type Ctx = { undo?: Array<() => void> } | undefined;

export function makeLedgerDb() {
  const wallets = new Map<string, any>();
  const entries: any[] = [];
  const transactions = new Map<string, any>();
  let n = 0;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: "P2002", meta: { target: [target] } });

  const byUnique = (where: any) => {
    const u = where.userId_currency;
    return [...wallets.values()].find((w) => w.userId === u.userId && w.currency === u.currency) ?? null;
  };
  const passes = (w: any, cond: any) => {
    for (const field of ["balance", "balanceMinor"]) {
      const c = cond?.[field];
      if (c?.gte !== undefined && !(w[field] >= c.gte)) return false;
    }
    return true;
  };

  // Applies a data object and returns its undo (inverse deltas for increments, never an absolute restore).
  const applyData = (w: any, data: any): (() => void) => {
    const undos: Array<() => void> = [];
    const field = (name: "balance" | "balanceMinor", v: any) => {
      if (v === undefined) return;
      if (typeof v === "object" && v !== null && v.increment !== undefined) {
        w[name] += v.increment;
        undos.push(() => void (w[name] -= v.increment));
      } else if (typeof v === "object" && v !== null && v.decrement !== undefined) {
        w[name] -= v.decrement;
        undos.push(() => void (w[name] += v.decrement));
      } else {
        const before = w[name];
        w[name] = v;
        undos.push(() => void (w[name] = before));
      }
    };
    const { balance, balanceMinor, ...rest } = data;
    field("balance", balance);
    field("balanceMinor", balanceMinor);
    const before = { ...rest };
    for (const k of Object.keys(rest)) before[k] = w[k];
    Object.assign(w, rest);
    return () => {
      for (const u of undos.reverse()) u();
      Object.assign(w, before);
    };
  };

  const api: any = {
    wallets,
    get entries() {
      return entries;
    },
    transactions,
    seedWallet(row: any) {
      const w = { id: `w${++n}`, balanceMinor: 0n, ...row };
      wallets.set(w.id, w);
      return w;
    },
    wallet: {
      findUnique: async ({ where }: any, _ctx?: Ctx) => {
        await tick();
        const w = where.id ? wallets.get(where.id) : byUnique(where);
        return w ? { ...w } : null;
      },
      findMany: async ({ take, cursor, skip, select, where }: any = {}, _ctx?: Ctx) => {
        let rows = [...wallets.values()].sort((a, b) => a.id.localeCompare(b.id));
        if (where?.balanceMinor?.lt !== undefined) rows = rows.filter((r) => r.balanceMinor < where.balanceMinor.lt);
        if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        if (take) rows = rows.slice(0, take);
        return select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows;
      },
      create: async ({ data }: any, ctx?: Ctx) => {
        await tick();
        if ([...wallets.values()].some((w) => w.userId === data.userId && w.currency === data.currency)) throw uniqueError("userId_currency");
        const w = { id: `w${++n}`, balanceMinor: 0n, ...data };
        wallets.set(w.id, w);
        ctx?.undo?.push(() => void wallets.delete(w.id));
        return { ...w };
      },
      update: async ({ where, data }: any, ctx?: Ctx) => {
        await tick();
        const w = wallets.get(where.id);
        const undo = applyData(w, data);
        ctx?.undo?.push(undo);
        return { ...w };
      },
      // The conditional update a debit relies on: applies only if the guard holds, atomically.
      updateMany: async ({ where, data }: any, ctx?: Ctx) => {
        await tick();
        const w = wallets.get(where.id);
        if (!w || !passes(w, where)) return { count: 0 };
        const undo = applyData(w, data);
        ctx?.undo?.push(undo);
        return { count: 1 };
      },
    },
    ledgerEntry: {
      create: async ({ data }: any, ctx?: Ctx) => {
        await tick();
        if (data.idempotencyKey && entries.some((e) => e.idempotencyKey === data.idempotencyKey)) throw uniqueError("idempotencyKey");
        const e = { id: `e${entries.length + 1}-${Math.random().toString(36).slice(2, 6)}`, seq: entries.length + 1, amountMinor: 0n, runningBalanceMinor: 0n, idempotencyKey: null, ...data };
        entries.push(e);
        ctx?.undo?.push(() => void entries.splice(entries.indexOf(e), 1));
        return e;
      },
      findUnique: async ({ where }: any, _ctx?: Ctx) => {
        await tick();
        return entries.find((e) => (where.idempotencyKey ? e.idempotencyKey === where.idempotencyKey : e.id === where.id)) ?? null;
      },
      findMany: async ({ take, cursor, skip, where }: any = {}, _ctx?: Ctx) => {
        let rows = [...entries].sort((a, b) => a.seq - b.seq);
        if (where?.walletId) rows = rows.filter((r) => r.walletId === where.walletId);
        if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        return take ? rows.slice(0, take) : rows;
      },
      update: async ({ where, data }: any) => Object.assign(entries.find((e) => e.id === where.id), data),
      groupBy: async () => {
        const acc = new Map<string, any>();
        for (const e of entries) {
          const k = `${e.walletId}|${e.direction}`;
          const row = acc.get(k) ?? { walletId: e.walletId, direction: e.direction, _sum: { amountMinor: 0n } };
          row._sum.amountMinor += e.amountMinor;
          acc.set(k, row);
        }
        return [...acc.values()];
      },
    },
    transaction: {
      findMany: async ({ take, cursor, skip }: any = {}) => {
        let rows = [...transactions.values()].sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        return take ? rows.slice(0, take) : rows;
      },
      update: async ({ where, data }: any) => Object.assign(transactions.get(where.id), data),
    },
    // A transaction object whose every call goes through the shared methods above, carrying its undo log.
    $transaction: async (fn: any) => {
      const ctx = { undo: [] as Array<() => void> };
      const via = (table: string, ...methods: string[]) => Object.fromEntries(methods.map((m) => [m, (args: any) => api[table][m](args, ctx)]));
      const tx = {
        wallet: via("wallet", "findUnique", "findMany", "create", "update", "updateMany"),
        ledgerEntry: via("ledgerEntry", "create", "findUnique", "findMany", "groupBy"),
        transaction: api.transaction,
      };
      try {
        return await fn(tx);
      } catch (error) {
        for (const u of ctx.undo.reverse()) u();
        throw error;
      }
    },
    reset() {
      wallets.clear();
      entries.length = 0;
      transactions.clear();
      n = 0;
    },
  };
  return api;
}
