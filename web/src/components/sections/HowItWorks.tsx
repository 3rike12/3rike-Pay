import { motion } from "motion/react";
import { Band, Eyebrow } from "@/components/primitives/Band";
import { LiteBubble } from "@/components/chat/LiteBubble";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { BEATS } from "@/data/content";
import type { ChatLine } from "@/data/chats";

/**
 * Talk → Confirm → Done.
 *
 * Three windows onto one conversation, in WhatsApp's *light* theme — which is
 * what most phones are set to, and what belongs on a paper section.
 *
 * The earlier version floated the messages on a bare beige rectangle, and a
 * bare beige rectangle is not a chat: it is a box of nothing with a few small
 * bubbles at the bottom. Two things fix that and both are chrome rather than
 * content. Each panel now carries the thread's own header — avatar, name,
 * presence — so you know at a glance what you are looking at, and the
 * wallpaper is doodled, so the room above the first message reads as the
 * conversation scrolled rather than as space nobody filled.
 *
 * The number and the step name moved down beside the writing they belong to,
 * which let the old connecting rail go. It was a hairline fading to
 * transparent at both ends across a 2rem gap, which is to say invisible.
 */

/** WhatsApp's own header bar, light chrome. Decoration, hence aria-hidden. */
function ChatHeader() {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center gap-2.5 border-b border-black/[0.07] bg-wa-lite-head px-3.5 py-2.5"
    >
      <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-black/[0.06]">
        <img src="/mark.png" alt="" width={256} height={256} className="size-[1.3rem]" />
      </span>

      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-chat text-[0.8125rem] font-semibold text-wa-lite-text">
          3rike&nbsp;Pay
        </span>
        <span className="block truncate font-chat text-[0.6875rem] text-wa-lite-dim">
          online
        </span>
      </span>

      <svg viewBox="0 0 24 24" className="size-[1.15rem] shrink-0 text-wa-lite-dim" fill="currentColor">
        <circle cx="12" cy="5" r="1.7" />
        <circle cx="12" cy="12" r="1.7" />
        <circle cx="12" cy="19" r="1.7" />
      </svg>
    </div>
  );
}

function Tick() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-[0.95rem] shrink-0 text-green-deep"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 8.5l3.6 3.6L13.5 4.4" />
    </svg>
  );
}

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

      <ol className="mt-12 grid gap-6 md:mt-16 md:grid-cols-3">
        {BEATS.map((beat, index) => (
          <motion.li
            key={beat.label}
            className="group flex"
            initial={reduced ? undefined : { opacity: 0, y: 26 }}
            whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-12% 0px" }}
            transition={{ duration: 0.65, delay: index * 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <article className="lift flex w-full flex-col overflow-hidden rounded-[1.5rem] border border-rule bg-paper-pure shadow-soft group-hover:border-ink/15 group-hover:shadow-float">
              <ChatHeader />

              {/* Bottom-anchored, as a thread is. Whatever room is left above
                  the first message is the conversation so far. */}
              <div className="wa-paper flex h-[13.5rem] flex-col justify-end gap-1.5 p-3.5 md:h-[14.5rem]">
                {beat.lines.map((line, lineIndex) => (
                  <LiteBubble key={lineIndex} line={line as ChatLine} />
                ))}
              </div>

              <div className="flex flex-1 flex-col p-5 md:p-6">
                <div className="flex items-center gap-2.5">
                  <span className="tnum grid size-[1.4rem] shrink-0 place-items-center rounded-full bg-green text-[0.75rem] font-bold text-ink">
                    {index + 1}
                  </span>
                  <span className="eyebrow text-green-deep">{beat.label}</span>
                </div>

                <h3 className="display-small mt-4 font-display text-balance">{beat.title}</h3>
                <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-ink-700">
                  {beat.body}
                </p>

                {/* The one claim this panel is evidence for. `mt-auto` on the
                    wrapper rather than the rule itself, so the three feet line
                    up across the row and still keep their gap when they
                    don't. */}
                <div className="mt-auto pt-5">
                  <p className="flex items-center gap-2 border-t border-rule pt-4 text-[0.8125rem] font-medium text-ink">
                    <Tick />
                    {beat.note}
                  </p>
                </div>
              </div>
            </article>
          </motion.li>
        ))}
      </ol>
    </Band>
  );
}
