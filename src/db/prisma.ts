import { PrismaClient } from "@prisma/client";
import { withTransactionMinor } from "@/utils/money";

// A Transaction's amount is also stored in whole minor units. Doing it here, on
// every create, covers all the places that write one without touching each.
// Only creates fill it: an update that changes the amount is rare and would need
// the currency, so `npm run money:minor -- --backfill` catches those.
function create() {
  // Never log queries: they flood prod logs and can leak bind parameters.
  // Errors (and warnings) are all we need here.
  return new PrismaClient({ log: ["warn", "error"] }).$extends({
    query: {
      transaction: {
        create({ args, query }) {
          return query({ ...args, data: withTransactionMinor(args.data as any) });
        },
      },
    },
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof create> | undefined;
};

export const prisma = globalForPrisma.prisma ?? create();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
