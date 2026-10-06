import { useEffect, useRef, useState } from "react";
import type { ChatScript } from "@/data/chats";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { Bubble, TypingDots } from "./Bubble";

/**
 * Plays a scripted conversation once, when it scrolls into view.
 *
 * This is the page's single orchestrated moment: the product is "you type a
 * sentence and money moves", so the hero shows exactly that happening rather
 * than describing it. Under prefers-reduced-motion the whole thread is there
 * from the start — the information is identical, only the theatre is dropped.
 */
export function ChatThread({
  script,
  className,
}: {
  script: ChatScript;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const { lines } = script;
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(reduced ? lines.length : 0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (reduced) {
      setShown(lines.length);
      setTyping(false);
      return;
    }

    const node = ref.current;
    if (!node) return;

    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });

    const play = async () => {
      await wait(500);
      for (let index = 0; index < lines.length; index += 1) {
        if (cancelled) return;
        const line = lines[index];

        if (line.from === "bot" && line.typingMs) {
          setTyping(true);
          await wait(line.typingMs);
          if (cancelled) return;
          setTyping(false);
        }

        setShown(index + 1);
        await wait(line.from === "user" ? 620 : 900);
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        void play();
      },
      { threshold: 0.35 }
    );

    observer.observe(node);

    return () => {
      cancelled = true;
      observer.disconnect();
      timers.forEach(window.clearTimeout);
    };
  }, [lines, reduced]);

  return (
    <div
      ref={ref}
      className={className}
      // The thread is a live-updating log; announce it politely rather than
      // firing a notification per bubble.
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="flex flex-col gap-2">
        {lines.slice(0, shown).map((line, index) => (
          <Bubble key={`${script.id}-${index}`} line={line} />
        ))}
        {typing && <TypingDots />}
      </div>
    </div>
  );
}
