import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { WHATSAPP_URL } from "@/lib/site";
import { useReducedMotion } from "@/lib/useReducedMotion";

const PLACEHOLDER = "Say hi to 3rike Pay";

type Props = {
  tone?: "light" | "dark";
  className?: string;
  /** Caret types the placeholder out, once, when scrolled into view. */
  animate?: boolean;
};

/**
 * The site's primary call to action, built as a WhatsApp composer bar.
 *
 * The thing you are being asked to do is send a message, so the button that
 * asks you is shaped like the box you send messages from. This is the one
 * loud idea on the page; everything around it stays quiet.
 */
export function Composer({ tone = "light", className, animate = true }: Props) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLAnchorElement>(null);
  const [typed, setTyped] = useState(animate && !reduced ? "" : PLACEHOLDER);

  useEffect(() => {
    if (!animate || reduced) {
      setTyped(PLACEHOLDER);
      return;
    }
    const node = ref.current;
    if (!node) return;

    let timer: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();

        let index = 0;
        const tick = () => {
          index += 1;
          setTyped(PLACEHOLDER.slice(0, index));
          if (index < PLACEHOLDER.length) timer = window.setTimeout(tick, 42);
        };
        timer = window.setTimeout(tick, 240);
      },
      { threshold: 0.6 }
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [animate, reduced]);

  const dark = tone === "dark";

  return (
    <a
      ref={ref}
      href={WHATSAPP_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="Start a chat with 3rike Pay on WhatsApp"
      className={cn(
        "group flex w-full max-w-[26rem] items-center gap-3 rounded-full p-1.5 pl-5 transition-colors duration-200",
        dark
          ? "border border-hairline-dark bg-ink-900 hover:border-grey-400/50"
          : "border border-hairline bg-paper shadow-[0_1px_0_rgba(10,10,10,0.04)] hover:border-ink/20",
        className
      )}
    >
      <span
        className={cn(
          "flex-1 truncate py-2 text-left text-[0.9375rem]",
          dark ? "text-grey-300" : "text-grey-500"
        )}
      >
        {typed}
        {typed.length < PLACEHOLDER.length && (
          <span className="ml-0.5 inline-block h-[1.05em] w-px translate-y-[0.15em] bg-green align-middle" />
        )}
      </span>

      <span
        aria-hidden
        className="grid size-11 shrink-0 place-items-center rounded-full bg-green text-ink transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
      >
        {/* WhatsApp's own send glyph, not a generic arrow. */}
        <svg viewBox="0 0 24 24" className="size-5 translate-x-px" fill="currentColor">
          <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.5.5 0 00-.7.56L4.3 10.3c.07.3.32.52.62.56l8.2.94c.3.04.3.36 0 .4l-8.2.94a.72.72 0 00-.62.56L2.7 19.84a.5.5 0 00.7.56z" />
        </svg>
      </span>
    </a>
  );
}
