import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eyebrow } from "@/components/primitives/Band";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * The parser, made operable.
 *
 * The earlier version stated that six different phrasings all parse and then
 * ran them past in a marquee, which asks you to take it on trust. This one
 * lets you change the input and watch the output refuse to change — the same
 * three fields come out of "Send 5k to 1234567890 GTBank" and "1234567890
 * opay 5k", and seeing that happen is the whole argument.
 *
 * It advances on its own so the point lands without interaction, and stops
 * the moment you take hold of it, because an autoplaying thing that fights
 * the pointer is worse than a static one.
 */

type Role = "amount" | "account" | "bank";
type Token = { t: string; role?: Role };

const PHRASINGS: { tokens: Token[]; out: Record<Role, string> }[] = [
  {
    tokens: [
      { t: "Send " },
      { t: "5k", role: "amount" },
      { t: " to " },
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "GTBank", role: "bank" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "GTBank" },
  },
  {
    tokens: [
      { t: "send " },
      { t: "5000", role: "amount" },
      { t: " to " },
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "gtb", role: "bank" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "GTBank" },
  },
  {
    tokens: [
      { t: "transfer " },
      { t: "five thousand", role: "amount" },
      { t: " to " },
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "guaranty trust", role: "bank" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "GTBank" },
  },
  {
    tokens: [
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "opay", role: "bank" },
      { t: " " },
      { t: "5k", role: "amount" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "Opay" },
  },
  {
    tokens: [
      { t: "pay " },
      { t: "5k", role: "amount" },
      { t: " to " },
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "moniepoint", role: "bank" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "Moniepoint" },
  },
  {
    tokens: [
      { t: "send " },
      { t: "₦5,000", role: "amount" },
      { t: " to " },
      { t: "1234567890", role: "account" },
      { t: " " },
      { t: "zenith", role: "bank" },
    ],
    out: { amount: "₦5,000.00", account: "1234567890", bank: "Zenith Bank" },
  },
];

const FIELDS: { role: Role; label: string; note: string }[] = [
  { role: "amount", label: "Amount", note: "digits, k, or words" },
  { role: "account", label: "Account", note: "any 10-digit number" },
  { role: "bank", label: "Bank", note: "nickname or full name" },
];

/** All three clear 7:1 on the night ground. */
const INK: Record<Role, string> = {
  amount: "text-lime",
  account: "text-green",
  bank: "text-amber",
};
const RULE: Record<Role, string> = {
  amount: "bg-lime",
  account: "bg-green",
  bank: "bg-amber",
};

const DWELL = 3200;

export function Language() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const region = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState(false);

  // Only run while the section is actually on screen.
  useEffect(() => {
    const el = region.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setLive(entry.isIntersecting), {
      threshold: 0.3,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || held || !live) return;
    const id = window.setInterval(
      () => setIndex((value) => (value + 1) % PHRASINGS.length),
      DWELL
    );
    return () => window.clearInterval(id);
  }, [reduced, held, live]);

  const current = PHRASINGS[index];

  return (
    <section className="on-night relative overflow-hidden bg-night py-20 text-paper md:py-28 lg:py-32">
      <div className="shell">
        <div className="mx-auto max-w-[46rem] text-center">
          <Eyebrow tone="lime" className="justify-center">
            No forms
          </Eyebrow>
          <h2 className="display-section mt-5 font-display text-balance">
            One sentence is the whole <span className="accent">form</span>.
          </h2>
          <p className="mx-auto mt-5 max-w-[42ch] text-[1.0625rem] leading-relaxed text-paper/65">
            No amount field, no bank dropdown, no account-number box. Change the
            wording below as much as you like — the three things 3rike Pay needs
            come out the same every time.
          </p>
        </div>

        {/* ---- The parser ---- */}
        <div
          ref={region}
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocusCapture={() => setHeld(true)}
          onBlurCapture={() => setHeld(false)}
          className="mx-auto mt-12 max-w-[56rem] md:mt-16"
        >
          <div className="overflow-hidden rounded-[1.75rem] border border-rule-dark bg-night-soft/70 shadow-stage backdrop-blur-sm">
            {/* Input */}
            <div className="flex min-h-[9.5rem] items-center justify-center px-5 py-9 sm:px-10 sm:py-12">
              <p
                aria-live="polite"
                className="rounded-[20px_20px_6px_20px] bg-wa-out px-5 py-4 text-left font-display text-[1.25rem] font-bold leading-[1.85] tracking-[-0.015em] text-wa-text sm:px-7 sm:py-5 sm:text-[1.75rem] md:text-[2.125rem]"
              >
                {current.tokens.map((token, i) =>
                  token.role ? (
                    <span key={i} className={cn("relative whitespace-nowrap", INK[token.role])}>
                      {token.t}
                      <span
                        aria-hidden
                        className={cn(
                          "absolute -bottom-[0.18em] left-0 h-[0.12em] w-full rounded-full",
                          RULE[token.role]
                        )}
                      />
                    </span>
                  ) : (
                    <span key={i}>{token.t}</span>
                  )
                )}
              </p>
            </div>

            {/* What came out of it */}
            <div className="grid gap-px border-t border-rule-dark bg-rule-dark sm:grid-cols-3">
              {FIELDS.map((field) => (
                <div key={field.role} className="bg-night px-5 py-5 sm:px-6 sm:py-7">
                  <p className="flex items-center gap-2">
                    <span aria-hidden className={cn("size-2 rounded-full", RULE[field.role])} />
                    <span className="eyebrow text-paper/50">{field.label}</span>
                  </p>
                  <p className="tnum mt-3 font-display text-[1.375rem] font-bold tracking-[-0.02em] sm:text-[1.5rem]">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={current.out[field.role]}
                        initial={reduced ? undefined : { opacity: 0, y: 8 }}
                        animate={reduced ? undefined : { opacity: 1, y: 0 }}
                        exit={reduced ? undefined : { opacity: 0, y: -8 }}
                        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                        className="inline-block"
                      >
                        {current.out[field.role]}
                      </motion.span>
                    </AnimatePresence>
                  </p>
                  <p className="mt-1.5 text-[0.8125rem] text-paper/60">{field.note}</p>
                </div>
              ))}
            </div>
          </div>

          {/* The other five ways to say it. */}
          <div className="mt-8 flex flex-col items-center gap-4">
            <p className="text-[0.875rem] text-paper/55">
              It reads all of these the same way
            </p>
            <div className="-mx-5 flex w-[calc(100%+2.5rem)] snap-x gap-2 overflow-x-auto px-5 pb-2 sm:mx-0 sm:w-auto sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
              {PHRASINGS.map((phrasing, i) => {
                const label = phrasing.tokens.map((token) => token.t).join("");
                const on = i === index;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-pressed={on}
                    className={cn(
                      "relative shrink-0 snap-start cursor-pointer overflow-hidden whitespace-nowrap rounded-full border px-4 py-2 font-chat text-[0.8125rem] transition-colors duration-300",
                      on
                        ? "border-lime/60 bg-lime/12 text-lime"
                        : "border-rule-dark text-paper/55 hover:border-paper/35 hover:text-paper"
                    )}
                  >
                    {label}
                    {/* The dwell timer, drawn under the active chip. */}
                    {on && !reduced && !held && (
                      <motion.span
                        key={`${i}-${index}`}
                        aria-hidden
                        className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-lime"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: DWELL / 1000, ease: "linear" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
