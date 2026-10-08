import { useEffect, useRef, useState } from "react";
import { Eyebrow } from "@/components/primitives/Band";
import { Surface } from "@/components/chat/Surface";
import { Bubble } from "@/components/chat/Bubble";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { BUSINESS_CUES, businessScript } from "@/data/chats";
import { BUSINESS_STEPS } from "@/data/content";

/**
 * Catalogue → invoice → request → settle, driven by the scroll.
 *
 * The surface pins while the four steps pass it, and the conversation advances
 * to match whichever step you are reading. Scrolling the page is literally
 * working through the flow, which is a far better explanation of it than four
 * screenshots side by side would be.
 *
 * Under reduced motion the pinning is dropped and the whole thread is printed
 * once above the steps, which still carries the information.
 */
export function BusinessFlow() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const blocks = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    if (reduced) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const index = blocks.current.indexOf(entry.target as HTMLLIElement);
          if (index >= 0) setStep(index);
        });
      },
      // A narrow band across the middle of the viewport, so the active step is
      // whichever one you are actually looking at.
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );

    blocks.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, [reduced]);

  const shown = reduced
    ? businessScript.lines.length
    : BUSINESS_CUES[step] ?? businessScript.lines.length;
  return (
    <section
      id="flow"
      className="on-night scroll-mt-24 bg-night py-20 text-paper md:py-28"
    >
      <div className="shell">
        <div className="max-w-[44rem]">
          <Eyebrow tone="lime">Getting paid</Eyebrow>
          <h2 className="display-section mt-5 max-w-[16ch] font-display text-balance">
            From order to settled, in one{" "}
            <span className="accent">thread</span>.
          </h2>
        </div>

        <div className="mt-14 grid gap-12 lg:mt-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          {/* ---- The pinned surface ---- */}
          <div className="lg:sticky lg:top-24 lg:flex lg:h-[calc(100vh-7rem)] lg:items-center">
            <Surface
              className="mx-auto h-[30rem] w-full max-w-[24rem] sm:h-[33rem] lg:h-[34rem] lg:max-w-none"
              presence="online"
              footer="Message"
            >
              <div className="flex flex-col gap-1.5">
                {businessScript.lines.slice(0, shown).map((line, index) => (
                  <Bubble key={index} line={line} animate={!reduced} />
                ))}
              </div>
            </Surface>
          </div>

          {/* ---- The steps ---- */}
          <ol className="flex flex-col">
            {BUSINESS_STEPS.map((item, index) => (
              <li
                key={item.label}
                ref={(node) => {
                  blocks.current[index] = node;
                }}
                className="border-t border-rule-dark py-10 last:border-b lg:flex lg:min-h-[55vh] lg:flex-col lg:justify-center lg:py-16"
              >
                <span className="flex items-center gap-3">
                  <span
                    className={cn(
                      "tnum grid size-[2.125rem] shrink-0 place-items-center rounded-full border text-[0.8125rem] font-semibold transition-colors duration-300",
                      step === index || reduced
                        ? "border-lime text-lime"
                        : "border-paper/25 text-paper/50"
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="eyebrow text-paper/70">{item.label}</span>
                </span>

                <h3
                  className={cn(
                    "display-small mt-6 max-w-[16ch] font-display transition-colors duration-500",
                    reduced || step === index ? "text-paper" : "lg:text-paper/60"
                  )}
                >
                  {item.title}
                </h3>
                <p className="mt-3 max-w-[40ch] text-[0.9375rem] leading-relaxed text-paper/65">
                  {item.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
