import { createLogger } from "@/utils/logger";
import { prisma } from "@/services/database";
import { whatsapp } from "@/services/whatsapp";
import { flutterwave } from "@/services/flutterwave";
import { MESSAGES } from "@/config/constants";
import { toRwandaPhone } from "@/utils/helpers";
import { screen } from "@/utils/flowCrypto";
import { createFlowRouter, FlowContext, FlowResult } from "@/utils/flowRouter";

const logger = createLogger("business-flow");

const FIRST_SCREEN = "BUSINESS_DETAILS";
const SAVED_SCREEN = "SAVED";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function notifyBusinessSaved(user: { phone: string | null }, text: string) {
  try {
    if (!user.phone) return;
    await whatsapp.sendTextMessage(user.phone, text);
  } catch (error: any) {
    logger.error("Failed to send business saved message", { error: error.message });
  }
}

interface BusinessInput {
  name: string;
  email: string;
  phone?: string;
  registrationNumber?: string;
}

/**
 * The business phone is never asked for — it is the WhatsApp number the
 * merchant is messaging from, which the Flow has no access to. It is only
 * stored for display, so a non-Rwanda number is kept as-is rather than
 * blocking the save; only a Rwanda number gets normalised to 078… form.
 */
function parseBusinessInput(
  data: any,
  phone?: string
): { input?: BusinessInput; error?: string } {
  const name = String(data?.business_name || "").trim();
  const email = String(data?.business_email || "").trim();
  const registrationNumber = String(data?.registration_number || "").trim() || undefined;

  if (name.length < 2 || name.length > 80) {
    return { error: "Enter a business name of at least 2 characters." };
  }
  if (!EMAIL_RE.test(email) || email.length > 120) {
    return { error: "That email address doesn't look right." };
  }

  return { input: { name, email, phone: phone || undefined, registrationNumber } };
}

/**
 * Saves the merchant's business profile. Upserts, so re-running the Flow
 * simply updates the existing record.
 */
async function handleBusinessDetails(ctx: FlowContext): Promise<FlowResult> {
  const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
  const raw = String(user?.phone || "").trim();
  const phone = toRwandaPhone(raw) || raw || undefined;

  const { input, error } = parseBusinessInput(ctx.data, phone);
  if (error || !input) {
    return screen(ctx.screen, { error_message: error || "Please check your details." });
  }

  try {
    await flutterwave.ensureBusiness({
      userId: ctx.userId,
      name: input.name,
      email: input.email,
      ...(input.phone ? { phone: input.phone } : {}),
      country: "RW",
      registrationNumber: input.registrationNumber,
    });
  } catch (error: any) {
    return screen(ctx.screen, { error_message: "Could not save that. Please try again." });
  }

  const details = [
    `• *${input.name}*`,
    ...(input.phone ? [`• ${input.phone}`] : []),
    `• ${input.email}`,
    ...(input.registrationNumber ? [`• RDB: ${input.registrationNumber}`] : []),
  ].join("\n");

  if (user?.phone) {
    await notifyBusinessSaved(user, MESSAGES.BUSINESS.PROFILE.SAVED(details));
  }

  return screen(SAVED_SCREEN);
}

const router = createFlowRouter({
  name: "business-flow",
  firstScreen: FIRST_SCREEN,
  expiredMessage: "Session expired. Type /business to restart.",
  screens: {
    [SAVED_SCREEN]: async () => screen(SAVED_SCREEN),
    [FIRST_SCREEN]: handleBusinessDetails,
  },
  // Any screen we do not recognise is still the details form: the Flow's
  // screen ids live in Meta, and a mismatch should degrade to saving rather
  // than bouncing the merchant out.
  fallback: handleBusinessDetails,
});

export default router;
