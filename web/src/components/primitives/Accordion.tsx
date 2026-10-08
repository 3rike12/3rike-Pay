import { useId, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A disclosure list.
 *
 * Buttons that own `aria-expanded` and `aria-controls`, panels animated by
 * `grid-template-rows` — the one way to transition to `auto` height without
 * measuring — and nothing hidden from assistive technology that a sighted
 * reader can see.
 *
 * Each row is a target in its own right: the whole width is pressable, it
 * tints on hover, and the open one carries a green rule down its left edge so
 * you can see where you are in the list from the far side of the page.
 */
export function Accordion({
  items,
  className,
  tone = "light",
}: {
  items: readonly { q: string; a: string }[];
  className?: string;
  tone?: "light" | "dark";
}) {
  const base = useId();
  const [open, setOpen] = useState<number | null>(0);

  const dark = tone === "dark";

  return (
    <dl
      className={cn(
        "overflow-hidden rounded-[1.5rem] border",
        dark ? "border-rule-dark bg-night-soft/40" : "border-rule bg-paper-pure",
        className
      )}
    >
      {items.map((item, index) => {
        const isOpen = open === index;
        const id = `${base}-${index}`;

        return (
          <div
            key={item.q}
            className={cn(
              "relative transition-colors duration-300",
              index > 0 && (dark ? "border-t border-rule-dark" : "border-t border-rule"),
              isOpen && (dark ? "bg-night-soft/70" : "bg-mint-soft")
            )}
          >
            {/* The position marker. Drawn rather than bordered so it can
                grow from the middle when the row opens. */}
            <span
              aria-hidden
              className={cn(
                "absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full bg-green transition-all duration-400 ease-brand",
                isOpen ? "h-[calc(100%-1.75rem)] opacity-100" : "h-0 opacity-0"
              )}
            />

            <dt>
              <button
                type="button"
                id={`${id}-btn`}
                aria-expanded={isOpen}
                aria-controls={`${id}-panel`}
                onClick={() => setOpen(isOpen ? null : index)}
                className={cn(
                  "group flex w-full cursor-pointer items-start gap-4 px-5 py-5 text-left transition-colors duration-200 md:gap-5 md:px-7 md:py-6",
                  dark ? "hover:bg-paper/[0.035]" : "hover:bg-ink/[0.025]"
                )}
              >
                <span
                  className={cn(
                    "tnum mt-[0.2rem] shrink-0 font-mono text-[0.75rem] transition-colors duration-300",
                    isOpen
                      ? dark
                        ? "text-lime"
                        : "text-green-deep"
                      : dark
                        ? "text-paper/35"
                        : "text-ink-700"
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>

                <span
                  className={cn(
                    "flex-1 font-display text-[1.0625rem] font-bold leading-snug tracking-[-0.015em] transition-colors duration-200 md:text-[1.1875rem]",
                    dark ? "text-paper" : "text-ink"
                  )}
                >
                  {item.q}
                </span>

                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border transition-all duration-400 ease-brand",
                    isOpen
                      ? "rotate-135 border-green bg-green text-ink"
                      : dark
                        ? "border-paper/25 text-paper/70 group-hover:border-paper/50"
                        : "border-ink/15 text-ink-700 group-hover:border-ink/35"
                  )}
                >
                  <svg
                    viewBox="0 0 14 14"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M7 2v10M2 7h10" />
                  </svg>
                </span>
              </button>
            </dt>

            <dd
              id={`${id}-panel`}
              className={cn(
                "grid transition-[grid-template-rows] duration-400 ease-brand",
                isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div className="overflow-hidden">
                <p
                  className={cn(
                    "max-w-[62ch] pb-6 pl-[3.1rem] pr-6 text-[0.9375rem] leading-relaxed md:pb-7 md:pl-[4.1rem] md:pr-12",
                    dark ? "text-paper/65" : "text-ink-700"
                  )}
                >
                  {item.a}
                </p>
              </div>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
