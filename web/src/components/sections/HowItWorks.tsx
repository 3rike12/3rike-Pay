import { motion } from "motion/react";
import { Band, Eyebrow } from "@/components/primitives/Band";
import { LiteBubble } from "@/components/chat/LiteBubble";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { BEATS } from "@/data/content";
import type { ChatLine } from "@/data/chats";

/**
 * Talk → Confirm → Done.
 *
 * The three beats are the actual messages, not descriptions of them, and they
 * are shown in WhatsApp's *light* theme — which is what most phones are set
 * to, and what belongs on a paper section. The earlier version cropped three
 * patches of dark chat onto a light page, which read as three screenshots
 * someone had pasted in rather than one conversation told in three parts.
 *
 * Each step is a whole card: the chat on top at a shared height so the three
 * align, the explanation under it, and a numbered rail connecting them.
 */
export function HowItWorks() {
  const reduced = useReducedMotion();

  return (
    <Band id="how" tone="paper" className="relative overflow-hidden">
      <div
        aria-hidden
        className="dotfield pointer-events-none absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_30%,black,transparent)]"
      />

      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
        <div className="max-w-[34rem]">
          <Eyebrow>How a transfer goes</Eyebrow>
          <h2 className="display-section mt-5 max-w-[16ch] font-display text-balance">
            Three messages, start to <span className="accent">finish</span>.
          </h2>
        </div>
        <p className="max-w-[32ch] text-[0.9375rem] leading-relaxed text-ink-700 md:pb-2 md:text-right">
          Nothing below is a mock-up of a flow we intend to build. It is the
          wording the bot sends today, in the order it sends it.
        </p>
      </div>

      <ol className="relative mt-14 grid gap-8 md:mt-20 md:grid-cols-3 md:gap-6 lg:gap-8">
        {/* The through-line. Hidden on mobile, where the beats stack. */}
        <span
          aria-hidden
          className="absolute left-[12%] right-[12%] top-[1.375rem] hidden h-px bg-gradient-to-r from-transparent via-rule to-transparent md:block"
        />

        {BEATS.map((beat, index) => (
          <motion.li
            key={beat.label}
            className="group relative flex flex-col"
            initial={reduced ? undefined : { opacity: 0, y: 26 }}
            whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-12% 0px" }}
            transition={{ duration: 0.65, delay: index * 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Step marker, sitting on the rail. */}
            <div className="relative z-10 flex items-center gap-3">
              <span className="tnum grid size-11 shrink-0 place-items-center rounded-full border border-green/25 bg-paper-pure text-[0.9375rem] font-semibold text-green-deep shadow-soft transition-colors duration-300 group-hover:border-green/55">
                {index + 1}
              </span>
              <span className="eyebrow rounded-full bg-mint px-3 py-1.5 text-green-deep">
                {beat.label}
              </span>
            </div>

            {/* The messages, on WhatsApp's own light wallpaper. */}
            <div className="lift mt-6 overflow-hidden rounded-[1.5rem] border border-rule bg-paper-pure shadow-soft group-hover:shadow-float">
              <div className="flex h-[14.5rem] flex-col justify-end gap-1.5 bg-wa-lite-bg p-4">
                {beat.lines.map((line, lineIndex) => (
                  <LiteBubble key={lineIndex} line={line as ChatLine} />
                ))}
              </div>

              <div className="p-5 md:p-6">
                <h3 className="display-small font-display text-balance">{beat.title}</h3>
                <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-ink-700">
                  {beat.body}
                </p>
              </div>
            </div>
          </motion.li>
        ))}
      </ol>
    </Band>
  );
}
