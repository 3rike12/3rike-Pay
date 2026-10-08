import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { ChatScript } from "@/data/chats";

export type PlayState = {
  /** How many lines have landed. */
  shown: number;
  /** True while the bot is composing the next line. */
  typing: boolean;
  /** Attach to the scrolling element so it can be observed. */
  ref: (node: HTMLElement | null) => void;
  done: boolean;
};

/**
 * Plays a script once the thread is on screen.
 *
 * Each line gets its own beat — a pause, then a typing indicator sized to the
 * message, then the bubble. Timing is per-line data rather than a constant,
 * because a four-line confirmation should take visibly longer to compose than
 * the word "balance".
 *
 * Under prefers-reduced-motion the whole thread is present from the first
 * frame: the information is the point, the typing is decoration.
 */
export function useScript(script: ChatScript, { start = true } = {}): PlayState {
  const reduced = useReducedMotion();
  const total = script.lines.length;

  const [shown, setShown] = useState(reduced ? total : 0);
  const [typing, setTyping] = useState(false);
  const [visible, setVisible] = useState(false);
  const node = useRef<HTMLElement | null>(null);
  const timers = useRef<number[]>([]);

  // Keep the finished state in sync if the preference flips mid-session.
  useEffect(() => {
    if (reduced) {
      setShown(total);
      setTyping(false);
    }
  }, [reduced, total]);

  const ref = (el: HTMLElement | null) => {
    node.current = el;
  };

  useEffect(() => {
    if (reduced || visible) return;
    const el = node.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduced, visible]);

  useEffect(() => {
    if (reduced || !visible || !start) return;

    let at = 0;
    const schedule = (fn: () => void, delay: number) => {
      at += delay;
      timers.current.push(window.setTimeout(fn, at));
    };

    script.lines.forEach((line, index) => {
      const gap = line.gapMs ?? 240;
      const compose = line.typingMs ?? 0;

      if (compose > 0) {
        schedule(() => setTyping(true), gap);
        schedule(() => {
          setTyping(false);
          setShown(index + 1);
        }, compose);
      } else {
        schedule(() => setShown(index + 1), gap);
      }
    });

    const copy = timers.current;
    return () => {
      copy.forEach(window.clearTimeout);
      timers.current = [];
    };
  }, [reduced, visible, start, script]);

  return { shown, typing, ref, done: shown >= total };
}
