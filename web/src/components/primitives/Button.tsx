import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Brand green carries ink labels, not white: #01C259 against white is 2.4:1
 * and fails AA, while #1A1A1A on that same green clears 7.3:1. Keeping the
 * brand colour and inverting the label beats dulling the brand.
 */
const tones = {
  solid:
    "bg-green text-ink shadow-[0_6px_18px_-8px_rgba(1,194,89,0.75)] hover:bg-green-hover hover:shadow-[0_10px_26px_-8px_rgba(1,194,89,0.85)]",
  lime: "bg-lime text-green-ink hover:bg-lime-pale",
  outline:
    "border border-ink/15 bg-paper-pure/60 text-ink hover:border-ink/35 hover:bg-paper-pure",
  ghostDark: "border border-paper/20 text-paper hover:border-paper/50 hover:bg-paper/10",
} as const;

export function Button({
  children,
  href,
  tone = "solid",
  className,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  href?: string;
  tone?: keyof typeof tones;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const classes = cn(
    "inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-full px-6 py-3.5",
    "text-[0.9375rem] font-semibold transition-all duration-300 ease-brand",
    "active:scale-[0.98]",
    tones[tone],
    className
  );

  if (href) {
    const external = href.startsWith("http");
    return (
      <a href={href} className={classes} {...(external ? { rel: "noreferrer" } : {})}>
        {children}
      </a>
    );
  }

  return (
    <button type={type} onClick={onClick} className={classes}>
      {children}
    </button>
  );
}

export function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-[1.15rem]", className)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 004.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2zm5.8 14.17c-.25.69-1.44 1.32-1.98 1.37-.53.05-1.02.24-3.44-.72-2.9-1.14-4.73-4.1-4.87-4.29-.14-.19-1.16-1.54-1.16-2.94 0-1.4.73-2.08 1-2.37.26-.29.57-.36.76-.36l.55.01c.17.01.41-.07.64.49.25.59.84 2.04.91 2.19.07.14.12.31.02.5-.09.19-.14.31-.28.48l-.42.49c-.14.14-.28.29-.12.57.16.29.72 1.18 1.54 1.92 1.06.94 1.95 1.23 2.23 1.37.28.14.44.12.6-.07.17-.19.69-.8.88-1.08.19-.29.38-.24.64-.14.25.09 1.6.76 1.88.9.28.14.46.21.53.33.07.12.07.69-.18 1.38z" />
    </svg>
  );
}

/** The downward chevron used on "see how it works" style links. */
export function ArrowGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2.5v11M3.5 9.5L8 14l4.5-4.5" />
    </svg>
  );
}
