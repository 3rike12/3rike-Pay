// An in-memory stand-in for the PaymentIntent, RailEvent and RailCursor tables,
// with the same unique rules (reference and openKey are unique), so tests can run
// the REAL rail event engine instead of mocking it. Use inside a
// vi.mock("@/db/prisma") factory.
export function makeIntentTables() {
  const intents = new Map<string, any>();
  const events: any[] = [];
  const cursors = new Map<string, string>();
  const uniqueError = () => Object.assign(new Error("unique"), { code: "P2002" });
  let n = 0;

  const find = (where: any) => {
    if (where.id) return intents.get(where.id) ?? null;
    if (where.reference) return [...intents.values()].find((i) => i.reference === where.reference) ?? null;
    if (where.openKey) return [...intents.values()].find((i) => i.openKey === where.openKey) ?? null;
    return null;
  };

  return {
    intents,
    events,
    cursors,
    reset() {
      intents.clear();
      events.length = 0;
      cursors.clear();
      n = 0;
    },
    paymentIntent: {
      findUnique: async ({ where }: any) => find(where),
      findMany: async ({ where }: any = {}) =>
        [...intents.values()].filter(
          (i) =>
            (!where?.rail || i.rail === where.rail) &&
            (where?.openKey?.not === undefined || i.openKey != null) &&
            (!where?.createdAt?.lt || i.createdAt < where.createdAt.lt)
        ),
      create: async ({ data }: any) => {
        if ([...intents.values()].some((i) => i.reference === data.reference)) throw uniqueError();
        if (data.openKey && [...intents.values()].some((i) => i.openKey === data.openKey)) throw uniqueError();
        const row = { id: `i${++n}`, openKey: null, createdAt: new Date(), ...data };
        intents.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = intents.get(where.id);
        if (!row || row.state !== where.state) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    railEvent: {
      create: async ({ data }: any) => {
        if (events.some((e) => e.intentId === data.intentId && e.type === data.type && e.dedupeKey === data.dedupeKey)) throw uniqueError();
        events.push(data);
        return data;
      },
    },
    railCursor: {
      findUnique: async ({ where }: any) => (cursors.has(where.key) ? { key: where.key, value: cursors.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => {
        cursors.set(where.key, cursors.has(where.key) ? update.value : create.value);
      },
    },
  };
}
