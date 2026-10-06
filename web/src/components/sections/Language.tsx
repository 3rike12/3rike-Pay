import { Heading, Section } from "@/components/primitives/Section";
import { Reveal } from "@/components/primitives/Reveal";
import { transferPhrasings } from "@/data/chats";

/**
 * The annotated example: one sentence, taken apart into what gets read out of
 * it. The three highlighted fragments are keyed to the legend beneath, which
 * is a plain list rather than floating labels — leader lines pinned to inline
 * text break the moment the sentence rewraps on a narrow screen.
 */
type Part = { text: string; highlight?: 1 | 2 | 3; mono?: boolean };

const PARTS: Part[] = [
  { text: "send " },
  { text: "5k", highlight: 1 },
  { text: " to " },
  { text: "1234567890", highlight: 2, mono: true },
  { text: " " },
  { text: "gtbank", highlight: 3 },
];

const LEGEND = [
  { key: 1, label: "the amount", note: "5k, 5000, or five thousand naira" },
  { key: 2, label: "the account", note: "any 10-digit number" },
  { key: 3, label: "the bank", note: "short names work too" },
] as const;

export function Language() {
  return (
    <Section tone="tint">
      <div className="grid gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
        <Heading
          title="One sentence is the whole form."
          body="No amount field, no bank dropdown, no account-number box. Write it how you'd text a friend and 3rike Pay takes it apart itself."
        />

        <div>
          <Reveal>
            <div className="bubble-out-lg bg-paper px-6 py-7 md:px-9 md:py-9">
              <p className="font-display text-[1.375rem] font-bold leading-[1.6] tracking-[-0.015em] md:text-[1.75rem]">
                {PARTS.map((part, index) =>
                  part.highlight ? (
                    <span
                      key={index}
                      className="whitespace-nowrap rounded-[0.3rem] bg-lime px-1.5 py-0.5"
                    >
                      <span className={part.mono ? "font-mono text-[0.84em]" : undefined}>
                        {part.text}
                      </span>
                    </span>
                  ) : (
                    <span key={index}>{part.text}</span>
                  )
                )}
              </p>

              <dl className="mt-8 grid gap-x-6 gap-y-4 border-t border-hairline pt-6 sm:grid-cols-3">
                {LEGEND.map((item) => (
                  <div key={item.key}>
                    <dt className="flex items-center gap-2 text-[0.875rem] font-semibold">
                      <span aria-hidden className="size-2.5 rounded-sm bg-lime" />
                      {item.label}
                    </dt>
                    <dd className="mt-1 pl-[1.125rem] text-[0.8125rem] leading-snug text-ink/65">
                      {item.note}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>

          <p className="mt-10 text-[0.9375rem] text-green-900/85">
            It reads all of these the same way:
          </p>

          <ul className="mt-4 flex flex-col gap-2.5">
            {transferPhrasings.slice(1).map((phrase, index) => (
              <Reveal key={phrase} as="li" delay={index * 0.06}>
                <span className="bubble-out block w-fit bg-paper px-4 py-2.5 font-chat text-[0.875rem] text-ink/80">
                  {phrase}
                </span>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
