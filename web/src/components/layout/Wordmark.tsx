import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * The mark is a chat bubble with a 3 in it — the brand's initial sitting in
 * the shape the whole product lives inside.
 */
export function Wordmark({
  tone = "light",
  className,
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <Link
      to="/"
      aria-label="3rike Pay, home"
      className={cn("flex items-center gap-2.5", className)}
    >
      <span className="bubble-in grid size-8 place-items-center bg-green font-display text-[1.05rem] font-extrabold leading-none text-white">
        3
      </span>
      <span
        className={cn(
          "font-display text-[1.1875rem] font-extrabold tracking-[-0.03em]",
          tone === "dark" ? "text-paper" : "text-ink"
        )}
      >
        3rike Pay
      </span>
    </Link>
  );
}
