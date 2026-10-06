import { cn } from "@/lib/cn";

/**
 * WhatsApp's double tick. Used as the bullet for things that are settled —
 * a read receipt is already the shared symbol for "this went through".
 */
export function Ticks({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 18 12"
      aria-hidden
      className={cn("size-[1.05rem] shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 6.8l3.1 3.2L10.4 2" />
      <path d="M6.6 6.8l3.1 3.2L16 2" />
    </svg>
  );
}
