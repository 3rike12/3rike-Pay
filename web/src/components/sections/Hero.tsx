import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Surface } from "@/components/chat/Surface";
import { Thread } from "@/components/chat/Thread";
import { WhatsAppGlyph, ArrowGlyph } from "@/components/primitives/Button";
import { heroScript, sendScript } from "@/data/chats";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { WHATSAPP_URL } from "@/lib/site";
import { HERO_PHOTO, HERO_TREATMENT } from "@/lib/heroTreatment";
import { cn } from "@/lib/cn";

/**
 * The hero.
 *
 * A photograph of Lagos behind, the product playing in front. The thread is
 * the real thing — a transfer from first message to receipt, rendered live at
 * a size where every figure is legible, not a screenshot and not footage.
 *
 * Two treatments are built; see lib/heroTreatment. On "photo" the picture
 * leads and the type reverses to paper; on "veil" the page stays light and the
 * picture sits behind a whitish scrim.
 *
 * The stage arrives tilted away from the reader and straightens as it settles.
 * That is the one piece of theatre on the page, and it is paid for: a flat
 * card dropped in place reads as a screenshot, while one that rights itself
 * reads as a screen.
 *
 * Load order is serial. The statement lands, then the stage, then the
 * conversation plays. Everything arriving at once is what makes a page feel
 * templated.
 */

const BEATS = {
  eyebrow: 0,
  headline: 0.08,
  lede: 0.38,
  actions: 0.5,
  meta: 0.62,
  stage: 0.26,
  /** When the conversation starts composing. */
  script: 1400,
};

export function Hero() {
  const photo = HERO_TREATMENT === "photo";
  const reduced = useReducedMotion();
  // Only the tall layout has room for all five beats. Below it the "initiated"
  // message — real, but redundant beside the receipt — pushes the opening
  // instruction off the top of the thread.
  const roomy = useMediaQuery("(min-width: 768px)");
  const script = roomy ? heroScript : sendScript;
  const [playing, setPlaying] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setPlaying(true);
      return;
    }
    const t = window.setTimeout(() => setPlaying(true), BEATS.script);
    return () => window.clearTimeout(t);
  }, [reduced]);

  const rise = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 20 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <section className="relative isolate overflow-hidden bg-paper pb-16 pt-28 sm:pt-32 md:pb-20 lg:pt-36">
      {/* Ground. The photograph, then whatever it takes to make type legible
          on top of it. Both scrims land on paper at the bottom edge so the
          stage and the band below inherit a clean hand-over. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <img
          src={HERO_PHOTO.src}
          srcSet={`${HERO_PHOTO.srcSmall} 1200w, ${HERO_PHOTO.src} 1920w`}
          sizes="100vw"
          alt=""
          width={1920}
          height={1080}
          // The LCP element: decoded eagerly and at high priority, because
          // everything else on this screen is cheap by comparison.
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 size-full object-cover object-[50%_32%]"
        />
        {photo ? (
          <>
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(6,15,10,0.58)_0%,rgba(6,15,10,0.46)_44%,rgba(6,15,10,0.62)_76%,var(--color-paper)_100%)]" />
            {/* A pool under the type column only. Darkening the whole frame to
                carry the lede would flatten the photograph; this keeps the
                edges open and puts the weight where the words are. */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_68%_56%_at_50%_38%,rgba(6,15,10,0.68),transparent_80%)]" />
          </>
        ) : (
          <>
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(245,245,240,0.62)_0%,rgba(245,245,240,0.70)_42%,rgba(245,245,240,0.92)_74%,var(--color-paper)_97%)]" />
            <div className="absolute left-1/2 top-[-28rem] size-[64rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(1,194,89,0.2),transparent_60%)]" />
          </>
        )}
      </div>

      <div className="shell relative">
        {/* ---- The statement ---- */}
        <div className="mx-auto max-w-[52rem] text-center">
          <motion.p {...rise(BEATS.eyebrow)} className="flex justify-center">
            <span
              className={cn(
                "inline-flex items-center gap-2.5 rounded-full border py-1.5 pl-2.5 pr-4 text-[0.8125rem] font-medium backdrop-blur-sm",
                photo
                  ? "border-paper/30 bg-paper/15 text-paper"
                  : "border-green/25 bg-paper-pure/70 text-green-deep"
              )}
            >
              <span className="relative grid size-5 place-items-center">
                <span
                  aria-hidden
                  className="absolute size-2.5 rounded-full bg-green"
                  style={reduced ? undefined : { animation: "pulse-ring 2.4s ease-out infinite" }}
                />
                <span aria-hidden className="size-2 rounded-full bg-green" />
              </span>
              Banking, inside WhatsApp
            </span>
          </motion.p>

          <motion.h1
            {...rise(BEATS.headline)}
            className={cn(
              "display-hero mx-auto mt-7 max-w-[11ch] font-display text-balance sm:max-w-[19ch]",
              photo && "text-paper [text-shadow:0_2px_24px_rgba(6,15,10,0.35)]"
            )}
          >
            Your bank{" "}
            <span className={cn("whitespace-nowrap", photo ? "text-lime" : "accent")}>
              lives in
            </span>{" "}
            your chats.
          </motion.h1>

          <motion.p
            {...rise(BEATS.lede)}
            className={cn(
              "mx-auto mt-6 max-w-[46ch] text-[1.0625rem] leading-relaxed sm:text-[1.1875rem]",
              photo ? "text-paper" : "text-ink-700"
            )}
          >
            Send money to any Nigerian bank by typing it the way you&rsquo;d say it.
            No app to download, no forms, no new password to forget.
          </motion.p>

          <motion.div
            {...rise(BEATS.actions)}
            className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-5"
          >
            <a
              href={WHATSAPP_URL}
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-green px-7 py-4 text-[1rem] font-semibold text-ink shadow-[0_10px_30px_-10px_rgba(1,194,89,0.9)] transition-all duration-300 ease-brand hover:bg-green-hover hover:shadow-[0_16px_38px_-10px_rgba(1,194,89,1)] active:scale-[0.98] sm:w-auto"
            >
              <WhatsAppGlyph />
              Chat on WhatsApp
            </a>

            <a
              href="#how"
              className={cn(
                "group inline-flex w-full items-center justify-center gap-2 rounded-full border px-7 py-4 text-[1rem] font-medium backdrop-blur-sm transition-all duration-300 ease-brand sm:w-auto",
                photo
                  ? "border-paper/35 bg-paper/12 text-paper hover:border-paper/60 hover:bg-paper/20"
                  : "border-ink/12 bg-paper-pure/60 text-ink hover:border-ink/30 hover:bg-paper-pure"
              )}
            >
              See how it works
              <ArrowGlyph className="size-3.5 transition-transform duration-300 group-hover:translate-y-0.5" />
            </a>
          </motion.div>

          <motion.p
            {...rise(BEATS.meta)}
            className={cn(
              "tnum mt-7 text-[0.8125rem]",
              photo ? "text-paper/70" : "text-ink-700/75"
            )}
          >
            Transfers from ₦100 to ₦1,000,000 · Every bank on the NIP network
          </motion.p>
        </div>

        {/* ---- The product, playing ---- */}
        <div className="relative mt-12 [perspective:1800px] sm:mt-14 lg:mt-16">
          <motion.div
            initial={reduced ? undefined : { opacity: 0, y: 48, rotateX: 15, scale: 0.94 }}
            animate={reduced ? undefined : { opacity: 1, y: 0, rotateX: 0, scale: 1 }}
            transition={{ duration: 1.3, delay: BEATS.stage, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto w-full max-w-[22rem] origin-top sm:max-w-[36rem] lg:max-w-[52rem]"
          >
            <div className="relative">
              <Surface
                size={roomy ? "lg" : "sm"}
                className="h-[25rem] w-full sm:h-[29rem] lg:h-[31rem]"
                presence={playing ? "online" : "last seen just now"}
                footer="Send 5k to 1234567890 GTBank"
              >
                <Thread
                  key={roomy ? "full" : "compact"}
                  script={script}
                  start={playing}
                  size={roomy ? "lg" : "sm"}
                  gap={roomy ? "gap-2.5" : "gap-1.5"}
                  anchor="top"
                  fadeTop
                />
              </Surface>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
