import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { cn } from "@/lib/cn";

type Item = { q: string; a: string };

/**
 * FAQ list. The open/close motion answers a click, which is the kind of
 * motion that earns its place — it shows what changed.
 */
export function Accordion({ items }: { items: readonly Item[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const reduced = useReducedMotion();
  const base = useId();

  return (
    <ul className="divide-y divide-hairline border-y border-hairline">
      {items.map((item, index) => {
        const isOpen = open === index;
        const panelId = `${base}-panel-${index}`;
        const buttonId = `${base}-button-${index}`;

        return (
          <li key={item.q}>
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : index)}
                className="flex w-full items-start gap-5 py-6 text-left"
              >
                <span
                  className={cn(
                    "flex-1 font-sans text-[1.0625rem] font-semibold tracking-[-0.01em] transition-colors",
                    isOpen ? "text-green-700" : "text-ink"
                  )}
                >
                  {item.q}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border transition-all duration-300",
                    isOpen
                      ? "rotate-45 border-green bg-green text-white"
                      : "border-hairline text-ink/50"
                  )}
                >
                  <svg viewBox="0 0 14 14" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M7 1.5v11M1.5 7h11" />
                  </svg>
                </span>
              </button>
            </h3>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  initial={reduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduced ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <p className="max-w-[60ch] pb-7 pr-12 text-ink/65">{item.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}
