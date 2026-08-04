import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create a demo user
  const demoUser = await prisma.user.upsert({
    where: { phone: "08012345678" },
    update: {},
    create: {
      phone: "08012345678",
      name: "Demo User",
      email: "demo@3rikepay.com",
      kycStatus: "none",
    },
  });
  console.log("Demo user:", demoUser);

  // Create demo session
  await prisma.userSession.upsert({
    where: { id: "demo-session-1" },
    update: {},
    create: {
      userId: demoUser.id,
      state: "idle",
      flowData: {},
    },
  });
  console.log("Demo session created");

  console.log("Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
