import { cn } from "@/lib/cn";

/**
 * Two identical halves sliding by -50% read as one unbroken loop.
 * Paused on hover so a name can actually be read.
 */
export function Marquee({
  items,
  className,
}: {
  items: readonly string[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden",
        // Fade the ends so names enter and leave rather than being cut off.
        "[mask-image:linear-gradient(90deg,transparent,black_7rem,black_calc(100%-7rem),transparent)]",
        className
      )}
    >
      <div className="animate-marquee flex w-max group-hover:[animation-play-state:paused]">
        {[0, 1].map((half) => (
          <ul key={half} aria-hidden={half === 1} className="flex shrink-0 items-center">
            {items.map((item) => (
              <li
                key={item}
                className="flex items-center gap-10 whitespace-nowrap px-5 font-display text-[1.375rem] font-semibold text-paper/45 md:text-[1.625rem]"
              >
                <span>{item}</span>
                <span className="size-1 rounded-full bg-green" />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
