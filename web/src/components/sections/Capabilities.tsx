import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eyebrow } from "@/components/primitives/Band";
import { Surface } from "@/components/chat/Surface";
import { Thread } from "@/components/chat/Thread";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { CAPABILITIES } from "@/data/content";
import {
  balanceScript,
  onboardingScript,
  sendScript,
  type ChatScript,
} from "@/data/chats";

const SCRIPTS: Record<string, ChatScript> = {
  send: sendScript,
  balance: balanceScript,
  account: onboardingScript,
};

/** What you would actually type to start each one. */
const TRIGGERS: Record<string, string> = {
  send: "Send 5k to 1234567890 GTBank",
  balance: "balance",
  account: "Hi",
};

const ICONS: Record<string, ReactNode> = {
  send: <path d="M3.4 20.4l17.4-7.5a1 1 0 000-1.84L3.4 3.6a1 1 0 00-1.4.92V9.2c0 .5.36.92.85.99l10.2 1.44c.35.05.35.69 0 .74L2.85 13.8a1 1 0 00-.85.99v4.68a1 1 0 001.4.92z" />,
  balance: (
    <path d="M4 5.5h13a3 3 0 013 3v9a3 3 0 01-3 3H4a3 3 0 01-3-3V8.5a3 3 0 013-3zm0-2.5h10a1 1 0 010 2H4a1 1 0 010-2zm12.5 10.75a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z" />
  ),
  account: (
    <path d="M12 2.5a4.25 4.25 0 110 8.5 4.25 4.25 0 010-8.5zM12 13c4.2 0 7.6 2.35 7.6 5.25V21H4.4v-2.75C4.4 15.35 7.8 13 12 13z" />
  ),
};

/**
 * What you can do, demonstrated rather than listed.
 *
 * The previous build hid the tabs inside a column of headings, which is why
 * nothing in it looked pressable. These are unambiguous controls — bordered,
 * iconed, and filled with brand green when active — and the panel beneath
 * them is a staged product shot rather than a bare chat window: the thread
 * floats on a mint ground beside the line you would type to start it.
 */
export function Capabilities() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduced = useReducedMotion();

  const move = (event: React.KeyboardEvent) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as const;
    const step = keys[event.key as keyof typeof keys];
    if (!step) return;
    event.preventDefault();
    const next = (active + step + CAPABILITIES.length) % CAPABILITIES.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const current = CAPABILITIES[active];

  return (
    <section
      id="features"
      className="relative scroll-mt-24 overflow-hidden bg-paper-pure py-20 md:py-28 lg:py-32"
    >
      <div
        aria-hidden
        className="dotfield pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_75%_50%_at_50%_0%,black,transparent)]"
      />

      <div className="shell relative">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
          <div className="max-w-[36rem]">
            <Eyebrow>In the thread</Eyebrow>
            <h2 className="display-section mt-5 max-w-[18ch] font-display text-balance">
              Everything happens where you already <span className="accent">are</span>.
            </h2>
          </div>
          <p className="max-w-[30ch] text-[0.9375rem] leading-relaxed text-ink-700 md:pb-2 md:text-right">
            Pick one and watch it run. Every thread below is the bot&rsquo;s real
            wording, not a storyboard.
          </p>
        </div>

        {/* ---- The controls ---- */}
        <div
          role="tablist"
          aria-label="What 3rike Pay can do"
          onKeyDown={move}
          className="-mx-5 mt-10 flex snap-x gap-2.5 overflow-x-auto px-5 pb-3 md:-mx-8 md:px-8 lg:mx-0 lg:mt-12 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 lg:pb-0"
        >
          {CAPABILITIES.map((capability, index) => {
            const selected = index === active;
            return (
              <button
                key={capability.id}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                role="tab"
                id={`cap-tab-${capability.id}`}
                aria-selected={selected}
                aria-controls="cap-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(index)}
                className={cn(
                  "group relative flex shrink-0 cursor-pointer snap-start items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all duration-300 ease-brand active:scale-[0.985] lg:px-5 lg:py-4",
                  selected
                    ? "border-green bg-green text-ink shadow-[0_10px_28px_-12px_rgba(1,194,89,0.9)]"
                    : "border-rule bg-paper/70 text-ink-700 hover:-translate-y-0.5 hover:border-ink/25 hover:bg-paper hover:text-ink hover:shadow-soft"
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl transition-colors duration-300",
                    selected ? "bg-ink/12 text-ink" : "bg-mint text-green-deep"
                  )}
                >
                  <svg viewBox="0 0 24 24" className="size-[1.05rem]" fill="currentColor" aria-hidden>
                    {ICONS[capability.id]}
                  </svg>
                </span>

                <span className="whitespace-nowrap text-[0.9375rem] font-semibold lg:whitespace-normal">
                  {capability.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* ---- The panel ---- */}
        <div
          role="tabpanel"
          id="cap-panel"
          aria-labelledby={`cap-tab-${current.id}`}
          tabIndex={0}
          className="mt-6 overflow-hidden rounded-[1.75rem] border border-rule bg-mint-soft shadow-soft lg:mt-8"
        >
          <div className="grid items-center gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-14 lg:p-12">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={current.id}
                initial={reduced ? undefined : { opacity: 0, y: 14 }}
                animate={reduced ? undefined : { opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, y: -10 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              >
                <h3 className="display-small max-w-[18ch] font-display text-balance">
                  {current.headline}
                </h3>
                <p className="mt-4 max-w-[46ch] text-[1rem] leading-relaxed text-ink-700">
                  {current.body}
                </p>

                <div className="mt-7">
                  <p className="eyebrow text-green-deep">You type</p>
                  <p className="mt-2.5 inline-flex max-w-full items-center gap-2.5 rounded-full border border-green/25 bg-paper-pure px-4 py-2.5">
                    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-green-deep" fill="currentColor" aria-hidden>
                      <path d="M4 4h16a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4V6a2 2 0 012-2zm3.5 5a1 1 0 100 2h9a1 1 0 100-2h-9z" />
                    </svg>
                    <span className="truncate font-mono text-[0.875rem] text-ink">
                      {TRIGGERS[current.id]}
                    </span>
                  </p>
                </div>
              </motion.div>
            </AnimatePresence>

            <div>
              <Surface className="mx-auto h-[30rem] w-full max-w-[22rem] lg:max-w-none">
                <Thread key={current.id} script={SCRIPTS[current.id]} fadeTop />
              </Surface>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
