import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * The lockup.
 *
 * The mark is the brand's own file — the olive tricycle and the RIKE wordmark
 * drawn as one glyph — with "Pay" set beside it in the display face so the
 * product name is complete without redrawing the logo. On dark grounds the
 * artwork is a flat single colour, so inverting it to paper is exact rather
 * than approximate.
 */
export function Wordmark({
  tone = "light",
  className,
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  const dark = tone === "dark";

  return (
    <Link
      to="/"
      aria-label="3rike Pay, home"
      className={cn(
        "group flex shrink-0 items-center gap-[0.4rem] transition-opacity duration-200 hover:opacity-80",
        className
      )}
    >
      <img
        src="/3rike-logo.png"
        alt=""
        width={556}
        height={164}
        className={cn(
          "h-[1.3rem] w-auto select-none sm:h-[1.45rem]",
          dark && "brightness-0 invert"
        )}
      />
      <span
        className={cn(
          // Optically centred on the RIKE cap-height rather than sitting on
          // its baseline, so the two halves read as one lockup.
          "font-display text-[1.0625rem] font-extrabold leading-none tracking-[-0.03em] sm:text-[1.1875rem]",
          dark ? "text-paper" : "text-ink"
        )}
      >
        Pay
      </span>
    </Link>
  );
}
