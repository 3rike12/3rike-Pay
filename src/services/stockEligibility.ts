import { config } from "@/config";

// ============================================
// Who may use stock features
//
// Every country is open EXCEPT the United States. The Base quest excludes
// projects that enable trading for US users, and the tokens' own terms are for
// people outside the US. That is the only rule: there is no allowlist of
// countries, and a country we cannot identify is allowed.
//
// A US number (dialling code 1, which Canada shares) or a declared US country
// is refused. This is a first filter on what we know, not identity
// verification. Turn it off with STOCKS_BLOCK_US=false.
// ============================================

const blocksUs = () => ((config as any).stocks?.blockUs ?? true) !== false;

/** The dialling code 1 is shared by the US, Canada and others, so it is treated as the US. */
export function isUsPhone(phone: string | null | undefined): boolean {
  return String(phone ?? "").replace(/\D/g, "").startsWith("1");
}

export type Eligibility = { ok: true } | { ok: false; reason: "us" };

export function checkStockEligibility(params: { phone?: string | null; country?: string | null }): Eligibility {
  if (!blocksUs()) return { ok: true };
  const declaredUs = String(params.country ?? "").toUpperCase() === "US";
  if (declaredUs || isUsPhone(params.phone)) return { ok: false, reason: "us" };
  return { ok: true };
}

export function eligibilityMessage(_e: Extract<Eligibility, { ok: false }>): string {
  return "Stocks aren't available to people in the United States.";
}
