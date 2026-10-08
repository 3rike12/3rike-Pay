/**
 * Single source of truth for the outward-facing numbers and links.
 * WHATSAPP_NUMBER is the business line users message; swap it here and
 * every CTA on the site follows.
 */
export const WHATSAPP_NUMBER = "2348109379285";

/** The same number, spaced the way WhatsApp itself prints it. */
export const WHATSAPP_DISPLAY = "+234 810 937 9285";

export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(
  "Hi"
)}`;

export const SUPPORT_EMAIL = "support@3rike.xyz";

/** Only accounts that actually exist. Add the rest once they are live. */
export const SOCIALS = [{ label: "X", href: "https://x.com/3rike_" }] as const;
