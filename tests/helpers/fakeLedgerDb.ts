// An in-memory Wallet + LedgerEntry store with the update semantics the ledger
// relies on (increment/decrement applied to the stored float, other fields
// set as given). Use inside a vi.mock("@/db/prisma") factory.
export function makeLedgerDb() {
  const wallets = new Map<string, any>();
  const entries: any[] = [];
  const transactions = new Map<string, any>();
  let n = 0;
  const key = (w: { userId: string; currency: string }) => `${w.userId}/${w.currency}`;
  const byUnique = (where: any) => {
    const u = where.userId_currency;
    return [...wallets.values()].find((w) => w.userId === u.userId && w.currency === u.currency) ?? null;
  };

  const api: any = {
    wallets,
    entries,
    seedWallet(row: any) {
      const w = { id: `w${++n}`, balanceMinor: 0n, ...row };
      wallets.set(w.id, w);
      return w;
    },
    wallet: {
      findUnique: async ({ where }: any) => (where.id ? wallets.get(where.id) ?? null : byUnique(where)),
      findMany: async ({ take, cursor, skip, select }: any = {}) => {
        let rows = [...wallets.values()].sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        if (take) rows = rows.slice(0, take);
        return select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows;
      },
      create: async ({ data }: any) => {
        const w = { id: `w${++n}`, balanceMinor: 0n, ...data };
        wallets.set(w.id, w);
        return w;
      },
      update: async ({ where, data }: any) => {
        const w = wallets.get(where.id);
        const { balance, balanceMinor, ...rest } = data;
        if (balance?.increment !== undefined) w.balance += balance.increment;
        else if (balance?.decrement !== undefined) w.balance -= balance.decrement;
        if (balanceMinor !== undefined && typeof balanceMinor === "object") w.balanceMinor += balanceMinor.increment;
        else if (balanceMinor !== undefined) w.balanceMinor = balanceMinor;
        Object.assign(w, rest);
        return { ...w };
      },
    },
    ledgerEntry: {
      create: async ({ data }: any) => {
        const e = { id: `e${entries.length + 1}`, amountMinor: 0n, runningBalanceMinor: 0n, ...data };
        entries.push(e);
        return e;
      },
      findMany: async ({ take, cursor, skip }: any = {}) => {
        let rows = [...entries].sort((a, b) => a.id.localeCompare(b.id));
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
    transactions,
    transaction: {
      findMany: async ({ take, cursor, skip }: any = {}) => {
        let rows = [...transactions.values()].sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
        return take ? rows.slice(0, take) : rows;
      },
      update: async ({ where, data }: any) => Object.assign(transactions.get(where.id), data),
    },
    $transaction: async (fn: any) => fn(api),
    reset() {
      wallets.clear();
      entries.length = 0;
      transactions.clear();
      n = 0;
    },
    key,
  };
  return api;
}
