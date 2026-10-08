import { motion } from "motion/react";
import { Band, Eyebrow } from "@/components/primitives/Band";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * The fee breakdown, as a worked example rather than a pricing table.
 *
 * Three-tier pricing cards would be a lie here — there is one rate. What a
 * merchant actually wants to know is what reaches them on a real invoice, so
 * that is what the section shows, line by line, in the order the ledger books
 * it: gross credited, platform fee debited, processor charge debited.
 */
const ROWS = [
  {
    label: "Invoice total",
    note: "What the customer approved on their phone",
    value: "₦8,500.00",
  },
  {
    label: "Platform fee",
    note: "3rike keeps 5% of collected invoices",
    value: "−₦425.00",
  },
  {
    label: "Processor charge",
    note: "Booked as its own line, never folded into our fee",
    value: "−₦119.00",
  },
] as const;

export function Fees() {
  const reduced = useReducedMotion();

  return (
    <Band id="fees" tone="wash" className="relative overflow-hidden">
      <div
        aria-hidden
        className="dotfield pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_60%_60%_at_80%_10%,black,transparent)]"
      />
      <div className="relative grid gap-12 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>Fees</Eyebrow>
          <h2 className="display-section mt-5 max-w-[13ch] font-display text-balance">
            You see every naira that{" "}
            <span className="accent">moved</span>.
          </h2>
          <p className="mt-5 max-w-[34ch] text-[1.0625rem] leading-relaxed text-ink-700">
            One rate, shown in full on the receipt. Your wallet is credited the gross
            and the fees come off as separate, inspectable entries — so nothing is
            quietly never credited.
          </p>
        </div>

        <div>
          <dl className="border-t border-green/25">
            {ROWS.map((row, index) => (
              <motion.div
                key={row.label}
                className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 border-b border-green/25 py-7"
                initial={reduced ? undefined : { opacity: 0, y: 12 }}
                whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-10% 0px" }}
                transition={{ duration: 0.5, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
              >
                <dt className="min-w-0 flex-1">
                  <span className="block font-display text-[1.125rem] font-bold tracking-[-0.018em]">
                    {row.label}
                  </span>
                  <span className="mt-1 block max-w-[40ch] text-[0.875rem] leading-relaxed text-ink-700">
                    {row.note}
                  </span>
                </dt>
                <dd
                  className={cn(
                    "tnum shrink-0 font-display text-[1.75rem] font-bold tracking-[-0.025em] md:text-[2.25rem]",
                    index === 0 ? "text-ink" : "text-ink-700"
                  )}
                >
                  {row.value}
                </dd>
              </motion.div>
            ))}

            {/* The line that matters. */}
            <motion.div
              className="mt-8 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 rounded-[1.25rem] bg-green px-6 py-6 text-ink shadow-[0_14px_38px_-14px_rgba(1,194,89,0.85)] md:px-8"
              initial={reduced ? undefined : { opacity: 0, y: 12 }}
              whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-10% 0px" }}
              transition={{ duration: 0.55, delay: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <dt className="font-display text-[1.125rem] font-bold tracking-[-0.018em]">
                Credited to your wallet
              </dt>
              <dd className="tnum font-display text-[2rem] font-extrabold tracking-[-0.03em] md:text-[2.75rem]">
                ₦7,956.00
              </dd>
            </motion.div>
          </dl>

          <p className="mt-6 text-[0.8125rem] leading-relaxed text-ink-700">
            A worked example on an ₦8,500 invoice. The processor&rsquo;s charge varies
            with the payment method; the platform rate is fixed and set per deployment.
          </p>
        </div>
      </div>
    </Band>
  );
}
