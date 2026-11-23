// A small world for testing stock orders: a cash ledger, a positions ledger, an
// order table and a venue you can steer. The ledgers honour idempotency keys and
// refuse overdrafts like the real ones, and every call yields (so concurrent
// callers interleave). `crashAfter` makes a named step throw once, to simulate the
// process dying at that exact moment.
import type { StockVenue, VenueResult, VenueStatus } from "../../src/services/stockVenue";

export function makeOrderWorld() {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const cash = new Map<string, number>(); // `${user}/${currency}` -> balance
  const cashKeys = new Map<string, { amount: number; direction: string }>();
  const holdings = new Map<string, bigint>(); // `${user}/${token}` -> units
  const holdingKeys = new Map<string, { units: bigint; direction: string }>();
  const orders = new Map<string, any>();
  const log: string[] = [];
  const crash = new Set<string>();

  const maybeCrash = (step: string) => {
    if (crash.has(step)) {
      crash.delete(step);
      throw new Error(`crash after ${step}`);
    }
  };

  const ledger = {
    debit: async (p: any) => {
      await tick();
      const k = `${p.userId}/${p.currency}`;
      const seen = p.idempotencyKey && cashKeys.get(p.idempotencyKey);
      if (seen) return { replayed: true };
      if ((cash.get(k) ?? 0) < p.amount) throw new Error(`Insufficient balance: ${cash.get(k) ?? 0} ${p.currency} available, ${p.amount} ${p.currency} requested`);
      cash.set(k, (cash.get(k) ?? 0) - p.amount);
      if (p.idempotencyKey) cashKeys.set(p.idempotencyKey, { amount: p.amount, direction: "debit" });
      log.push(`cash-debit:${p.amount}`);
      maybeCrash("cash-debit");
      return { replayed: false };
    },
    credit: async (p: any) => {
      await tick();
      const k = `${p.userId}/${p.currency}`;
      if (p.idempotencyKey && cashKeys.get(p.idempotencyKey)) return { replayed: true };
      cash.set(k, (cash.get(k) ?? 0) + p.amount);
      if (p.idempotencyKey) cashKeys.set(p.idempotencyKey, { amount: p.amount, direction: "credit" });
      log.push(`cash-credit:${p.amount}`);
      maybeCrash("cash-credit");
      return { replayed: false };
    },
  };

  const positions = {
    debit: async (p: any) => {
      await tick();
      const k = `${p.userId}/${p.tokenAddress}`;
      if (p.idempotencyKey && holdingKeys.get(p.idempotencyKey)) return { replayed: true };
      if ((holdings.get(k) ?? 0n) < p.units) throw new Error(`Insufficient units: ${holdings.get(k) ?? 0n} held, ${p.units} requested`);
      holdings.set(k, (holdings.get(k) ?? 0n) - p.units);
      if (p.idempotencyKey) holdingKeys.set(p.idempotencyKey, { units: p.units, direction: "debit" });
      log.push(`units-debit:${p.units}`);
      maybeCrash("units-debit");
      return { replayed: false };
    },
    credit: async (p: any) => {
      await tick();
      const k = `${p.userId}/${p.tokenAddress}`;
      if (p.idempotencyKey && holdingKeys.get(p.idempotencyKey)) return { replayed: true };
      holdings.set(k, (holdings.get(k) ?? 0n) + p.units);
      if (p.idempotencyKey) holdingKeys.set(p.idempotencyKey, { units: p.units, direction: "credit" });
      log.push(`units-credit:${p.units}`);
      maybeCrash("units-credit");
      return { replayed: false };
    },
  };

  const uniqueError = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const stockOrder = {
    findUnique: async ({ where }: any) => {
      await tick();
      const o = orders.get(where.reference);
      return o ? { ...o } : null;
    },
    create: async ({ data }: any) => {
      await tick();
      if (orders.has(data.reference)) throw uniqueError();
      const o = { id: `o${orders.size + 1}`, state: "created", txHash: null, failure: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      orders.set(o.reference, o);
      return { ...o };
    },
    // The guarded transition: applies only if the order is still in `state`.
    updateMany: async ({ where, data }: any) => {
      await tick();
      const o = orders.get(where.reference);
      if (!o || (where.state !== undefined && o.state !== where.state)) return { count: 0 };
      Object.assign(o, data, { updatedAt: new Date() });
      maybeCrash(`state:${data.state}`);
      return { count: 1 };
    },
    findMany: async ({ where }: any = {}) => {
      await tick();
      return [...orders.values()].filter((o) => (!where?.state || o.state === where.state) && (!where?.updatedAt?.lt || o.updatedAt < where.updatedAt.lt)).map((o) => ({ ...o }));
    },
  };

  /** A venue whose behaviour a test steers. Idempotent on reference, like a real one must be. */
  function makeVenue(opts: { price?: number } = {}) {
    const price = opts.price ?? 100; // USD per token
    const book = new Map<string, VenueStatus>();
    const calls = { buy: 0, sell: 0, status: 0 };
    const script: { buy: Array<"fill" | "reject" | "timeout" | "fill-then-timeout">; status?: VenueStatus | "throw"; impactBps: number } = { buy: [], impactBps: 10 };
    const venue: StockVenue & { calls: typeof calls; script: typeof script; book: typeof book; lastBuy?: any; lastSell?: any } = {
      id: "test-venue",
      calls,
      script,
      book,
      async quoteBuy(token, usdcUnits) {
        await tick();
        // usdc has 6 decimals, the token 8: tokens = usd / price
        const tokenUnits = (usdcUnits * 10n ** BigInt(token.decimals)) / (BigInt(Math.round(price * 1e6)));
        return { tokenUnits, priceImpactBps: script.impactBps };
      },
      async quoteSell(token, tokenUnits) {
        await tick();
        return { usdcUnits: (tokenUnits * BigInt(Math.round(price * 1e6))) / 10n ** BigInt(token.decimals), priceImpactBps: script.impactBps };
      },
      async buy(req) {
        calls.buy++;
        venue.lastBuy = req;
        await tick();
        const known = book.get(req.reference);
        if (known && known.state === "filled") return { status: "filled", tokenUnits: known.tokenUnits, usdcUnits: known.usdcUnits, txHash: known.txHash };
        const mode = script.buy.shift() ?? "fill";
        if (mode === "reject") {
          book.set(req.reference, { state: "rejected", reason: "slippage" });
          return { status: "rejected", reason: "slippage" } as VenueResult;
        }
        const tokenUnits = (req.usdcUnits * 10n ** BigInt(req.token.decimals)) / BigInt(Math.round(price * 1e6));
        if (mode === "timeout") throw new Error("request timed out"); // never reached the venue
        book.set(req.reference, { state: "filled", tokenUnits, usdcUnits: req.usdcUnits, txHash: "0xfill" });
        if (mode === "fill-then-timeout") throw new Error("request timed out"); // it DID trade
        return { status: "filled", tokenUnits, usdcUnits: req.usdcUnits, txHash: "0xfill" };
      },
      async sell(req) {
        calls.sell++;
        venue.lastSell = req;
        await tick();
        const mode = script.buy.shift() ?? "fill";
        if (mode === "reject") {
          book.set(req.reference, { state: "rejected", reason: "slippage" });
          return { status: "rejected", reason: "slippage" };
        }
        if (mode === "timeout") throw new Error("request timed out");
        const usdcUnits = (req.tokenUnits * BigInt(Math.round(price * 1e6))) / 10n ** BigInt(req.token.decimals);
        book.set(req.reference, { state: "filled", tokenUnits: req.tokenUnits, usdcUnits, txHash: "0xsell" });
        if (mode === "fill-then-timeout") throw new Error("request timed out");
        return { status: "filled", tokenUnits: req.tokenUnits, usdcUnits, txHash: "0xsell" };
      },
      async status(reference) {
        calls.status++;
        await tick();
        if (script.status === "throw") throw new Error("venue unreachable");
        if (script.status) return script.status;
        return book.get(reference) ?? { state: "not_found" };
      },
    };
    return venue;
  }

  return {
    cash, holdings, orders, log, crash, ledger, positions, stockOrder, makeVenue,
    setCash: (user: string, currency: string, n: number) => cash.set(`${user}/${currency}`, n),
    cashOf: (user: string, currency: string) => cash.get(`${user}/${currency}`) ?? 0,
    unitsOf: (user: string, token: string) => holdings.get(`${user}/${token}`) ?? 0n,
    reset() {
      cash.clear(); cashKeys.clear(); holdings.clear(); holdingKeys.clear(); orders.clear(); log.length = 0; crash.clear();
    },
  };
}
