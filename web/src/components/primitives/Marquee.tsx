import { useReducedMotion } from "@/lib/useReducedMotion";
import { cn } from "@/lib/cn";

/**
 * A slow horizontal marquee.
 *
 * Duplicated once and translated by exactly -50%, so the seam is invisible.
 * Hover and keyboard focus pause it, and under reduced motion it becomes a
 * plain horizontally-scrollable row — still readable, still complete.
 */
export function Marquee({
  items,
  speed = 48,
  reverse = false,
  className,
  separator = "·",
  gap = "gap-8",
}: {
  items: readonly string[];
  /** Seconds for one full pass. */
  speed?: number;
  reverse?: boolean;
  className?: string;
  separator?: string;
  gap?: string;
}) {
  const reduced = useReducedMotion();
  const run = [...items, ...items];

  if (reduced) {
    return (
      <div className={cn("overflow-x-auto px-5 py-1", className)}>
        <ul className={cn("flex w-max", gap)}>
          {items.map((item) => (
            <li key={item} className="shrink-0 whitespace-nowrap">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={cn("group relative overflow-hidden", className)}>
      <ul
        className={cn(
          "flex w-max group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]",
          gap
        )}
        style={{
          animation: `marquee-slide ${speed}s linear infinite`,
          animationDirection: reverse ? "reverse" : "normal",
        }}
      >
        {run.map((item, index) => (
          <li
            key={`${item}-${index}`}
            className={cn("flex shrink-0 items-center whitespace-nowrap", separator && "gap-8")}
            aria-hidden={index >= items.length}
          >
            {item}
            {separator && (
              <span aria-hidden className="opacity-40">
                {separator}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
