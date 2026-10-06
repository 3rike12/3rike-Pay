import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Props = {
  href: string;
  children: ReactNode;
  variant?: "solid" | "outline" | "onDark";
  className?: string;
  external?: boolean;
};

/**
 * Buttons carry outgoing-bubble corners — the squared corner sits bottom-right,
 * the same side as a message you sent. Pressing one is you talking.
 */
export function Button({
  href,
  children,
  variant = "solid",
  className,
  external = true,
}: Props) {
  const base =
    "bubble-out inline-flex items-center justify-center px-6 py-3.5 text-[0.9375rem] font-semibold transition-colors duration-200";

  const tones = {
    solid: "bg-green text-ink hover:bg-lime",
    outline:
      "border border-ink/15 bg-paper text-ink hover:border-ink/35 hover:bg-mist",
    onDark: "bg-lime text-green-900 hover:bg-lime-100",
  } as const;

  return (
    <a
      href={href}
      className={cn(base, tones[variant], className)}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}
