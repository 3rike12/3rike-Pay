import { motion } from "motion/react";
import { Band, Eyebrow } from "@/components/primitives/Band";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { TESTIMONIALS } from "@/data/content";

/**
 * Three remarks, staggered.
 *
 * Still not a row of testimonial cards with five stars and a stock portrait:
 * the quote carries the weight, set in the display face at reading size, and
 * the attribution is a line of text under a rule. What is new is that each
 * one now sits on its own ground with the opening quote mark drawn large
 * behind it — enough structure to look deliberate, not enough to look like a
 * component someone installed.
 */
const OFFSETS = ["lg:mt-0", "lg:mt-14", "lg:mt-7"];

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Testimonials() {
  const reduced = useReducedMotion();

  return (
    <Band tone="paper">
      <div className="max-w-[40rem]">
        <Eyebrow>From the thread</Eyebrow>
        <h2 className="display-section mt-5 max-w-[16ch] font-display text-balance">
          People stopped opening the <span className="accent">app</span>.
        </h2>
      </div>

      <ul className="mt-12 grid gap-6 md:mt-16 md:grid-cols-3 md:gap-6">
        {TESTIMONIALS.map((item, index) => (
          <motion.li
            key={item.name}
            className={cn("group", OFFSETS[index])}
            initial={reduced ? undefined : { opacity: 0, y: 22 }}
            whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-12% 0px" }}
            transition={{ duration: 0.6, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}
          >
            <figure className="lift relative flex h-full flex-col overflow-hidden rounded-[1.5rem] border border-rule bg-paper-pure p-7 shadow-soft group-hover:border-green/35 group-hover:shadow-float md:p-8">
              <span
                aria-hidden
                className="pointer-events-none absolute -right-2 -top-6 select-none font-display text-[7rem] font-extrabold leading-none text-green/10 transition-colors duration-500 group-hover:text-green/20"
              >
                &rdquo;
              </span>

              <blockquote className="relative flex-1 font-display text-[1.1875rem] font-medium leading-[1.5] tracking-[-0.015em] text-ink md:text-[1.3125rem]">
                {item.quote}
              </blockquote>

              <figcaption className="mt-7 flex items-center gap-3 border-t border-rule pt-5">
                <span
                  aria-hidden
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-mint font-display text-[0.8125rem] font-bold text-green-deep"
                >
                  {initials(item.name)}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[0.9375rem] font-semibold text-ink">
                    {item.name}
                  </span>
                  <span className="block truncate text-[0.8125rem] text-ink-700">
                    {item.role}
                  </span>
                </span>
              </figcaption>
            </figure>
          </motion.li>
        ))}
      </ul>
    </Band>
  );
}
