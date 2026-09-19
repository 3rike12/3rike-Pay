import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";
import { redactPhone } from "@/utils/helpers";

const logger = createLogger("database");

export { prisma };

// ------- User helpers -------

export async function findOrCreateUser(phone: string, name?: string) {
  let user = await prisma.user.findUnique({
    where: { phone },
    include: { bankAccount: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: { phone, name: name || null },
      include: { bankAccount: true },
    });
    logger.info("New user created", { phone: redactPhone(phone), userId: user.id });
  } else if (name && user.name !== name) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name },
      include: { bankAccount: true },
    });
  }
  return user;
}

export async function getSession(userId: string) {
  let session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  if (!session) {
    session = await prisma.userSession.create({
      data: { userId, state: "idle", flowData: Prisma.JsonNull },
    });
  }
  return session;
}

export async function updateSession(
  userId: string,
  state: string,
  flowData?: Record<string, unknown>
) {
  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  if (!session) return null;

  return prisma.userSession.update({
    where: { id: session.id },
    data: {
      state,
      flowData: (flowData !== undefined ? flowData : session.flowData) as Prisma.InputJsonValue,
      lastActivity: new Date(),
    },
  });
}

export async function resetSession(userId: string) {
  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  if (!session) return null;

  return prisma.userSession.update({
    where: { id: session.id },
    data: {
      state: "idle",
      flowData: {},
      lastActivity: new Date(),
    },
  });
}

export async function createTransaction(params: {
  userId: string;
  reference: string;
  type: string;
  amount: number;
  description?: string;
  bankCode?: string;
  bankAccount?: string;
  bankName?: string;
  accountName?: string;
  recipientPhone?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.transaction.create({
    data: {
      ...params,
      metadata: (params.metadata || {}) as Prisma.InputJsonValue,
    },
  });
}

export async function getTransactionByReference(reference: string) {
  return prisma.transaction.findUnique({
    where: { reference },
  });
}

export async function updateTransaction(
  reference: string,
  data: Record<string, unknown>
) {
  return prisma.transaction.update({
    where: { reference },
    data,
  });
}

export async function logWebhookEvent(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
  reference?: string
) {
  const existing = await prisma.webhookEvent.findFirst({
    where: { source, eventType, reference },
  });
  if (existing) {
    logger.warn("Duplicate webhook event", { source, eventType, reference });
    return existing;
  }
  return prisma.webhookEvent.create({
    data: { source, eventType, payload: payload as Prisma.InputJsonValue, reference },
  });
}

// ------- User Profile -------

export async function createUserProfile(userId: string, data: { firstName?: string; lastName?: string; email?: string }) {
  return prisma.userProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

// ------- Bank Account -------

export async function createBankAccount(userId: string, data: {
  autorampSubId?: string;
  reference?: string;
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
  bankName?: string;
}) {
  return prisma.bankAccount.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

// ------- User Credentials -------

export async function createUserCredential(userId: string, data: {
  bvn?: string;
  nin?: string;
  identityId?: string;
  pin?: string;
}) {
  return prisma.userCredential.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export async function updateUserPin(userId: string, pin: string) {
  return prisma.userCredential.upsert({
    where: { userId },
    update: { pin },
    create: { userId, pin },
  });
}

// ------- User with details -------

export async function getUserWithDetails(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, bankAccount: true, credentials: true },
  });
}
