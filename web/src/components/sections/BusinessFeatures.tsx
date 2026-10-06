import { Heading, Section } from "@/components/primitives/Section";
import { cn } from "@/lib/cn";
import { BUSINESS_FEATURES } from "@/data/content";

export function BusinessFeatures() {
  return (
    <Section id="invoices" tone="mist">
      <Heading
        at="14:20"
        title="The shop is the conversation."
        body="Your customers already message you. This turns that thread into the place they pay you, too."
      />

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {BUSINESS_FEATURES.map((feature, index) => (
          <article
            key={feature.title}
            className={cn(
              "flex flex-col p-7",
              // Alternating bubble sides keep a six-tile grid from reading as
              // one block of identical cards.
              index % 2 === 0
                ? "bubble-in-lg border border-hairline bg-paper"
                : "bubble-out-lg bg-paper"
            )}
          >
            <h3 className="font-display text-[1.1875rem] font-bold tracking-[-0.015em]">
              {feature.title}
            </h3>
            <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-ink/65">
              {feature.body}
            </p>
          </article>
        ))}
      </div>
    </Section>
  );
}
