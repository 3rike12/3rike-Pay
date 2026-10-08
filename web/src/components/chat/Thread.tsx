import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { Bubble, TypingDots, type BubbleSize } from "@/components/chat/Bubble";
import { useScript } from "@/components/chat/useScript";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { ChatScript } from "@/data/chats";

/**
 * A plain thread — bubbles on the WhatsApp dark ground, no surrounding chrome.
 *
 * The thread owns its own scroller so that a long script rides up smoothly as
 * it plays rather than snapping; `overflow-hidden` keeps the scrollbar out of
 * the picture while still allowing a programmatic scroll, which is how a real
 * chat behaves when you are not the one dragging it.
 */
export function Thread({
  script,
  className,
  gap = "gap-1.5",
  start = true,
  size = "sm",
  anchor = "bottom",
  fadeTop = false,
}: {
  script: ChatScript;
  className?: string;
  gap?: string;
  /** Hold the script until the surrounding composition has settled. */
  start?: boolean;
  size?: BubbleSize;
  /** Where a thread shorter than its box settles. */
  anchor?: "top" | "bottom";
  /** Soften the top edge, for a thread tall enough to run off it. */
  fadeTop?: boolean;
}) {
  const reduced = useReducedMotion();
  const { shown, typing, ref } = useScript(script, { start });
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [shown, typing, reduced]);

  return (
    <div
      // One node does both jobs: it is the box that scrolls, and the box whose
      // visibility starts the script. Observing the inner column instead would
      // deadlock — it has no height until the first bubble lands, so it can
      // never cross the observer's threshold.
      ref={(node) => {
        scroller.current = node;
        ref(node);
      }}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden",
        anchor === "top" ? "justify-start" : "justify-end",
        fadeTop &&
          "[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)] [mask-size:100%_100%]",
        className
      )}
    >
      <div
        // The pad matches the fade, so the first message starts clear of it
        // and only messages that have scrolled past get softened.
        className={cn("flex flex-col", gap, fadeTop && "pt-14")}
      >
        {script.lines.slice(0, shown).map((line, index) => (
          <Bubble key={index} line={line} size={size} />
        ))}
        {typing && <TypingDots size={size} />}
      </div>
    </div>
  );
}
