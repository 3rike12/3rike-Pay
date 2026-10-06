import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Props = {
  id?: string;
  children: ReactNode;
  /** Dark bands set `on-dark` so focus rings switch to lime. */
  tone?: "paper" | "mist" | "tint" | "ink";
  className?: string;
};

const tones = {
  paper: "bg-paper text-ink",
  mist: "bg-mist text-ink",
  tint: "bg-green-50 text-ink",
  ink: "on-dark bg-ink text-paper",
} as const;

export function Section({ id, children, tone = "paper", className }: Props) {
  return (
    <section
      id={id}
      className={cn("scroll-mt-20 py-20 md:py-28", tones[tone], className)}
    >
      <div className="shell">{children}</div>
    </section>
  );
}

/**
 * Section heading. The small line above it is a chat timestamp rather than a
 * tracked-out label — this site measures itself in message times.
 */
export function Heading({
  at,
  title,
  body,
  tone = "light",
  className,
}: {
  at?: string;
  title: ReactNode;
  body?: ReactNode;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <div className={cn("max-w-[44ch]", className)}>
      {at && (
        <p className={cn("stamp mb-4", tone === "dark" && "text-grey-300")}>{at}</p>
      )}
      <h2 className="display-lg">{title}</h2>
      {body && (
        <p
          className={cn(
            "mt-5 text-[1.0625rem] leading-relaxed",
            tone === "dark" ? "text-grey-300" : "text-ink/65"
          )}
        >
          {body}
        </p>
      )}
    </div>
  );
}
