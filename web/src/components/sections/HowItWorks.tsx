import { Heading, Section } from "@/components/primitives/Section";
import { Reveal } from "@/components/primitives/Reveal";
import { cn } from "@/lib/cn";
import { STEPS } from "@/data/content";

/**
 * Onboarding, drawn as the conversation it is.
 *
 * The steps are a real sequence, so they are ordered — but the order is carried
 * by the message timestamps rather than by 01 / 02 / 03 markers, because here
 * the sequence genuinely is a chat log.
 *
 * The thread is deliberately kept to a narrow column. A conversation that
 * spans the full width of a desktop page stops looking like a conversation.
 */
export function HowItWorks() {
  return (
    <Section id="how" tone="mist">
      <div className="grid gap-12 lg:grid-cols-[0.78fr_1fr] lg:gap-20">
        <Heading
          at="09:12"
          title="Four messages and you have an account."
          body="This is the whole of signing up. There is no onboarding screen anywhere, because there is no app for one to live in."
          className="lg:sticky lg:top-28 lg:self-start"
        />

        <ol className="flex flex-col gap-3">
          {STEPS.map((step, index) => {
            const outgoing = step.from === "user";

            return (
              <Reveal
                key={step.title}
                as="li"
                delay={index * 0.07}
                className={cn("flex", outgoing ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "w-[92%] px-6 py-5 md:px-7 md:py-6",
                    outgoing
                      ? "bubble-out-lg bg-green text-ink"
                      : "bubble-in-lg border border-hairline bg-paper"
                  )}
                >
                  <h3 className="font-display text-[1.1875rem] font-bold tracking-[-0.02em] md:text-[1.3125rem]">
                    {step.title}
                  </h3>
                  <p
                    className={cn(
                      "mt-2 max-w-[48ch] text-[0.9375rem] leading-relaxed",
                      outgoing ? "text-ink/75" : "text-ink/65"
                    )}
                  >
                    {step.body}
                  </p>
                  <span
                    className={cn(
                      "stamp mt-4 block text-right",
                      outgoing && "text-ink/70"
                    )}
                  >
                    {step.at}
                  </span>
                </div>
              </Reveal>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}
