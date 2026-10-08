import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A full-width horizontal band.
 *
 * Deliberately thin: it owns the ground colour, the vertical rhythm and the
 * scroll anchor, and nothing else. Headings, grids and composition belong to
 * each section, because a shared "label / heading / paragraph / cards" helper
 * is precisely what makes a site look generated.
 */
export function Band({
  children,
  id,
  tone = "paper",
  className,
  bleed = false,
}: {
  children: ReactNode;
  id?: string;
  tone?: "paper" | "pure" | "night" | "green" | "wash";
  className?: string;
  /** Skip the inner `shell` wrapper for edge-to-edge content. */
  bleed?: boolean;
}) {
  const tones = {
    paper: "bg-paper text-ink",
    pure: "bg-paper-pure text-ink",
    wash: "bg-mint text-ink",
    night: "on-night bg-night text-paper",
    green: "bg-green text-green-ink",
  } as const;

  return (
    <section
      id={id}
      className={cn("scroll-mt-24 py-20 md:py-28 lg:py-32", tones[tone], className)}
    >
      {bleed ? children : <div className="shell">{children}</div>}
    </section>
  );
}

/** Small uppercase section marker. Used sparingly — not on every band. */
export function Eyebrow({
  children,
  tone = "green",
  className,
}: {
  children: ReactNode;
  tone?: "green" | "lime" | "dim";
  className?: string;
}) {
  const tones = {
    green: "text-green-deep",
    lime: "text-lime",
    dim: "text-ink-700",
  } as const;

  return (
    <p className={cn("eyebrow flex items-center gap-2.5", tones[tone], className)}>
      <span aria-hidden className="inline-block h-px w-7 bg-current opacity-50" />
      {children}
    </p>
  );
}
