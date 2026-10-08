import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Eyebrow } from "@/components/primitives/Band";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { WHATSAPP_URL } from "@/lib/site";

const DRAFT = "Send 5k to 1234567890 GTBank";

const REASSURANCE = [
  "No download",
  "No forms",
  "Works on the phone you already have",
];

/**
 * The closing CTA, as the composer you would actually type into.
 *
 * The whole page has been one conversation, so it ends at the point where
 * yours would start: the message writes itself when the band comes into view
 * and the send button is the link. Under reduced motion the draft is simply
 * already written.
 */
export function CtaBand({
  title = (
    <>
      Your bank is one message <span className="accent">away</span>.
    </>
  ),
  body = "Say hi and 3rike Pay will walk you through it. Two minutes to an account, and then you never open a banking app again.",
}: {
  title?: ReactNode;
  body?: string;
} = {}) {
  const reduced = useReducedMotion();
  const [typed, setTyped] = useState(reduced ? DRAFT.length : 0);
  const node = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reduced) {
      setTyped(DRAFT.length);
      return;
    }
    const el = node.current;
    if (!el) return;

    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        let i = 0;
        timer = window.setInterval(() => {
          i += 1;
          setTyped(i);
          if (i >= DRAFT.length) window.clearInterval(timer);
        }, 52);
      },
      { threshold: 0.4 }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [reduced]);

  const complete = typed >= DRAFT.length;

  return (
    <section className="on-night bg-night-deep pb-10 pt-24 text-paper md:pb-12 md:pt-32">
      {/* The footer sits on the same ground, so the bottom pad only has to
          separate the chips from its panel — not open a second gap. */}
      <div className="shell">
        <div ref={node} className="mx-auto max-w-[44rem] text-center">
          <Eyebrow tone="lime" className="justify-center">
            Ready when you are
          </Eyebrow>
          <h2 className="display-section mt-5 font-display text-balance">{title}</h2>
          <p className="mx-auto mt-5 max-w-[40ch] text-[1.0625rem] leading-relaxed text-paper/65">
            {body}
          </p>
        </div>

        {/* The composer. */}
        <motion.a
          href={WHATSAPP_URL}
          initial={reduced ? undefined : { opacity: 0, y: 20 }}
          whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-10% 0px" }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="group mx-auto mt-12 block w-full max-w-[38rem] rounded-[1.5rem] border border-white/[0.09] bg-wa-head/80 p-2.5 shadow-stage backdrop-blur-sm transition-colors duration-300 hover:border-green/40"
        >
          <div className="flex items-center gap-2.5">
            <span className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full bg-wa-in px-4 py-3.5 sm:gap-3 sm:px-5">
              <svg
                viewBox="0 0 24 24"
                className="size-[1.05rem] shrink-0 text-wa-dim sm:size-[1.15rem]"
                fill="currentColor"
                aria-hidden
              >
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-3.5 7.5a1.3 1.3 0 112.6 0 1.3 1.3 0 01-2.6 0zm4.4 0a1.3 1.3 0 112.6 0 1.3 1.3 0 01-2.6 0zM12 17.3c-2.2 0-4-1.3-4.7-3.2h9.4c-.7 1.9-2.5 3.2-4.7 3.2z" />
              </svg>
              <span className="min-w-0 flex-1 truncate text-left font-chat text-[0.8125rem] text-wa-text sm:text-[0.9375rem] md:text-[1rem]">
                {DRAFT.slice(0, typed)}
                <span
                  aria-hidden
                  className="ml-px inline-block h-[1.05em] w-[2px] translate-y-[0.16em] bg-lime"
                  style={
                    reduced || !complete
                      ? undefined
                      : { animation: "caret-blink 1.1s step-end infinite" }
                  }
                />
              </span>
            </span>

            <span className="relative grid shrink-0 place-items-center">
              {complete && !reduced && (
                <span
                  aria-hidden
                  className="absolute size-11 rounded-full bg-green/60 sm:size-12"
                  style={{ animation: "pulse-ring 2.2s ease-out infinite" }}
                />
              )}
              <span className="relative grid size-11 place-items-center rounded-full bg-green text-ink sm:size-12 transition-all duration-300 ease-brand group-hover:bg-green-hover group-hover:scale-105">
                <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                  <path d="M3.4 20.4l17.4-7.5a1 1 0 000-1.84L3.4 3.6a1 1 0 00-1.4.92V9.2c0 .5.36.92.85.99l10.2 1.44c.35.05.35.69 0 .74L2.85 13.8a1 1 0 00-.85.99v4.68a1 1 0 001.4.92z" />
                </svg>
              </span>
            </span>
          </div>

          <span className="mt-2 block px-5 pb-1 text-left text-[0.75rem] text-paper/60">
            Tap to open WhatsApp with this message ready to send
          </span>
        </motion.a>

        <ul className="mx-auto mt-9 flex flex-wrap items-center justify-center gap-x-3 gap-y-2.5">
          {REASSURANCE.map((item) => (
            <li
              key={item}
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.04] px-3.5 py-1.5 text-[0.8125rem] text-paper/70"
            >
              <svg
                viewBox="0 0 14 14"
                className="size-3 text-lime"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M2.2 7.4l3.1 3.2L11.8 3.6" />
              </svg>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
