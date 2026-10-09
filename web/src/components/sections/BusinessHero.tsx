import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Button, WhatsAppGlyph } from "@/components/primitives/Button";
import { Surface } from "@/components/chat/Surface";
import { Thread } from "@/components/chat/Thread";
import { invoiceScript } from "@/data/chats";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { WHATSAPP_URL } from "@/lib/site";

export function BusinessHero() {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setPlaying(true);
      return;
    }
    const t = window.setTimeout(() => setPlaying(true), 1050);
    return () => window.clearTimeout(t);
  }, [reduced]);

  const rise = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.75, delay, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <section className="relative isolate overflow-hidden bg-paper pb-20 pt-28 sm:pt-32 lg:pb-28 lg:pt-36">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="dotfield absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_75%_55%_at_30%_0%,black,transparent)]" />
        <div className="absolute right-[-18rem] top-[-24rem] size-[56rem] rounded-full bg-[radial-gradient(circle,rgba(1,194,89,0.2),rgba(226,244,144,0.14)_40%,transparent_66%)]" />
      </div>

      <div className="shell">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-12 xl:gap-20">
          <div className="relative z-10">
            <motion.p {...rise(0)}>
              <span className="inline-flex items-center gap-2.5 rounded-full border border-green/25 bg-paper-pure/70 py-1.5 pl-2.5 pr-4 text-[0.8125rem] font-medium text-green-deep backdrop-blur-sm">
                <span className="relative grid size-5 place-items-center">
                  <span
                    aria-hidden
                    className="absolute size-2.5 rounded-full bg-green"
                    style={reduced ? undefined : { animation: "pulse-ring 2.4s ease-out infinite" }}
                  />
                  <span aria-hidden className="size-2 rounded-full bg-green" />
                </span>
                For businesses in Rwanda
              </span>
            </motion.p>

            <motion.h1
              {...rise(0.1)}
              className="display-hero mt-5 max-w-[13ch] font-display"
            >
              Get paid{" "}
              <span className="accent">before</span> they
              leave.
            </motion.h1>

            <motion.p
              {...rise(0.42)}
              className="mt-6 max-w-[38ch] text-[1.0625rem] leading-relaxed text-ink-700 sm:text-[1.125rem]"
            >
              Type the order and send the request. The prompt opens on your
              customer&rsquo;s own mobile money — MTN, Airtel or KTRN — and the money
              settles into your wallet. No POS terminal, no account number to
              dictate, no screenshot to chase.
            </motion.p>

            <motion.div {...rise(0.56)} className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
              <Button href={WHATSAPP_URL}>
                <WhatsAppGlyph />
                Start billing customers
              </Button>
              <a
                href="#fees"
                className="inline-flex items-center rounded-full border border-ink/12 bg-paper-pure/60 px-6 py-3.5 text-[0.9375rem] font-medium text-ink backdrop-blur-sm transition-all duration-300 ease-brand hover:border-ink/30 hover:bg-paper-pure"
              >
                See what it costs
              </a>
            </motion.div>

            <motion.p {...rise(0.68)} className="tnum mt-8 text-[0.8125rem] text-ink-700/80">
              Collected in RWF over mobile money · 5% platform fee, itemised on every receipt
            </motion.p>
          </div>

          <motion.div
            initial={reduced ? undefined : { opacity: 0, y: 36 }}
            animate={reduced ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            <Surface className="mx-auto h-[33rem] w-full max-w-[26rem] sm:h-[35rem] lg:h-[41rem] xl:h-[43rem]">
              <Thread script={invoiceScript} start={playing} fadeTop />
            </Surface>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
