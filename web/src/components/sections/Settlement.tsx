import { Heading, Section } from "@/components/primitives/Section";
import { Reveal } from "@/components/primitives/Reveal";
import { PLATFORM_FEE_PERCENT } from "@/data/fees";

/**
 * The settlement message, shown as the itemised thing it is.
 *
 * The bot deliberately splits the platform's cut from the processor's charge
 * instead of printing one "fees" total, because a single number hides which of
 * the two moved. The site makes the same distinction rather than quietly
 * rounding it into "low fees".
 */
const LINES: { label: string; value: string; strong?: boolean }[] = [
  { label: "Customer paid", value: "₦2,100.00", strong: true },
  { label: `Platform fee (${PLATFORM_FEE_PERCENT}%)`, value: "−₦105.00" },
  { label: "Processor charge", value: "−₦29.40" },
];

export function Settlement() {
  return (
    <Section id="fees" tone="ink">
      <div className="grid gap-14 lg:grid-cols-[1fr_0.85fr] lg:items-center lg:gap-20">
        <Heading
          tone="dark"
          title="You see every naira that was taken off the top."
          body={`When an invoice settles, 3rike Pay sends you the amount, who paid it, the platform's ${PLATFORM_FEE_PERCENT}% and the processor's charge as separate lines, then your new balance. One lump sum labelled "fees" would hide which of the two moved.`}
        />

        <Reveal>
          <div className="bubble-in-lg bg-ink-900 p-7 md:p-8">
            <p className="stamp text-grey-400">14:23</p>

            <dl className="mt-5 flex flex-col">
              {LINES.map((line) => (
                <div
                  key={line.label}
                  className="flex items-baseline justify-between gap-6 border-b border-hairline-dark py-3.5 first:pt-0"
                >
                  <dt className="text-[0.9375rem] text-grey-400">{line.label}</dt>
                  <dd
                    className={
                      line.strong
                        ? "font-display text-[1.0625rem] font-bold tabular-nums text-paper"
                        : "text-[0.9375rem] tabular-nums text-paper/80"
                    }
                  >
                    {line.value}
                  </dd>
                </div>
              ))}

              <div className="flex items-baseline justify-between gap-6 pt-5">
                <dt className="text-[0.9375rem] font-medium text-lime">
                  New wallet balance
                </dt>
                <dd className="font-display text-[1.5rem] font-extrabold tabular-nums text-lime">
                  ₦186,340.00
                </dd>
              </div>
            </dl>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
