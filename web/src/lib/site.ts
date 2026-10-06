/**
 * Single source of truth for the outward-facing numbers and links.
 * WHATSAPP_NUMBER is the business line users message; swap it here and
 * every CTA on the site follows.
 */
export const WHATSAPP_NUMBER = "2347000037453";

export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(
  "Hi"
)}`;

export const SUPPORT_EMAIL = "support@3rike.xyz";

export const SOCIALS = [
  { label: "X", href: "https://x.com/3rike_xyz" },
  { label: "Instagram", href: "https://instagram.com/3rike.xyz" },
  { label: "LinkedIn", href: "https://linkedin.com/company/3rike" },
] as const;
