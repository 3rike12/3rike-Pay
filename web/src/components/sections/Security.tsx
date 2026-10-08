import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Eyebrow } from "@/components/primitives/Band";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { SECURITY } from "@/data/content";

/**
 * Security, as an instrument panel.
 *
 * Four claims on a hairline grid with the mechanism named in mono beside each
 * one. No shields with ticks on them, no "bank-grade", no padlock wallpaper:
 * the specifics are more reassuring than the iconography, and every one of
 * them names a file you could go and read.
 *
 * Dark, because this is the one section where the page should feel like it is
 * standing still.
 */
const ICONS: ReactNode[] = [
  // Identity
  <path
    key="id"
    d="M12 2.2l7.5 3v6.1c0 4.6-3.1 8.6-7.5 10.5-4.4-1.9-7.5-5.9-7.5-10.5V5.2l7.5-3zm3.6 6.6l-4.8 4.8-2.3-2.3-1.5 1.5 3.8 3.8 6.3-6.3-1.5-1.5z"
  />,
  // Sealed form
  <path
    key="flow"
    d="M12 1.8a4.7 4.7 0 014.7 4.7V9H19a1.6 1.6 0 011.6 1.6v9.1A1.6 1.6 0 0119 21.3H5a1.6 1.6 0 01-1.6-1.6v-9.1A1.6 1.6 0 015 9h2.3V6.5A4.7 4.7 0 0112 1.8zm0 2.3a2.4 2.4 0 00-2.4 2.4V9h4.8V6.5A2.4 2.4 0 0012 4.1zm0 9.1a1.9 1.9 0 00-.9 3.56v1.44a.9.9 0 101.8 0v-1.44A1.9 1.9 0 0012 13.2z"
  />,
  // Hash
  <path
    key="hash"
    d="M9.4 2.6l-.7 4.4H4.5a1.1 1.1 0 000 2.2h3.85l-.62 3.9H3.6a1.1 1.1 0 100 2.2h3.78l-.69 4.3a1.1 1.1 0 102.17.35L9.6 15.3h4.03l-.69 4.3a1.1 1.1 0 102.17.35l.74-4.65h4.25a1.1 1.1 0 100-2.2h-3.9l.62-3.9h4.08a1.1 1.1 0 100-2.2h-3.73l.69-4.3a1.1 1.1 0 10-2.17-.35L14.95 7h-4.03l.69-4.3a1.1 1.1 0 10-2.17-.35zM10.57 9.2h4.03l-.62 3.9h-4.03l.62-3.9z"
  />,
  // Rate limit
  <path
    key="rate"
    d="M12 2.8a9.2 9.2 0 109.2 9.2h-2.3A6.9 6.9 0 1112 5.1V2.8zm1.15 3.45v5.3l3.9 2.3-.86 1.45-4.77-2.82V6.25h1.73zM15.4 3.1l5.5 1.4-1.4 5.5-4.1-6.9z"
  />,
];

export function Security() {
  const reduced = useReducedMotion();

  return (
    <section
      id="security"
      className="on-night scroll-mt-24 bg-night py-20 text-paper md:py-28 lg:py-32"
    >
      <div className="shell">
        <div className="max-w-[46rem]">
          <Eyebrow tone="lime">Safety</Eyebrow>
          <h2 className="display-section mt-5 max-w-[14ch] font-display text-balance">
            Boring where it <span className="accent">counts</span>.
          </h2>
          <p className="mt-5 max-w-[48ch] text-[1.0625rem] leading-relaxed text-paper/65">
            A chat interface should not mean a casual one. Four things stand
            between a stranger and your money, and none of them is a promise —
            each is a named mechanism.
          </p>
        </div>

        {/* Hairline grid: one rule colour showing through a 1px gap, so the
            four read as panels on one instrument rather than four cards. */}
        <div className="mt-12 grid gap-px overflow-hidden rounded-[1.75rem] border border-rule-dark bg-rule-dark md:mt-16 md:grid-cols-2">
          {SECURITY.map((item, index) => (
            <motion.article
              key={item.title}
              className="group relative flex flex-col bg-night p-7 transition-colors duration-500 hover:bg-night-soft md:p-9"
              initial={reduced ? undefined : { opacity: 0, y: 18 }}
              whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-10% 0px" }}
              transition={{ duration: 0.55, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-start justify-between gap-6">
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-lime/20 bg-lime/10 text-lime transition-colors duration-500 group-hover:border-lime/45 group-hover:bg-lime/15">
                  <svg viewBox="0 0 24 24" className="size-[1.3rem]" fill="currentColor" aria-hidden>
                    {ICONS[index]}
                  </svg>
                </span>
                <span className="tnum font-display text-[0.8125rem] font-bold text-paper/50">
                  0{index + 1}
                </span>
              </div>

              <h3 className="mt-6 max-w-[24ch] font-display text-[1.1875rem] font-bold leading-[1.22] tracking-[-0.02em] md:text-[1.375rem]">
                {item.title}
              </h3>
              <p className="mt-3 max-w-[48ch] flex-1 text-[0.9375rem] leading-relaxed text-paper/60">
                {item.body}
              </p>

              <p className="mt-6">
                <span className="inline-flex items-center gap-2 rounded-full border border-rule-dark bg-night-deep px-3.5 py-1.5 font-mono text-[0.75rem] text-lime">
                  <span aria-hidden className="size-1.5 rounded-full bg-lime/70" />
                  {item.detail}
                </span>
              </p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
