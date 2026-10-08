import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { BubbleSize } from "@/components/chat/Bubble";

/**
 * The conversation surface.
 *
 * Deliberately *not* a phone. No bezel, no notch, no rounded-rectangle device
 * render — on a desktop page those read as a stock mockup, which is exactly
 * the thing we are trying not to look like. What is left is the chat itself,
 * floating: WhatsApp's own dark chrome at a size where every message is
 * genuinely readable, which is the point of the whole hero.
 *
 * At `lg` it is the wide WhatsApp-Web proportion rather than a blown-up phone,
 * because stretching phone-sized chrome across a desktop column is the tell
 * that something is a mockup.
 */
export function Surface({
  children,
  className,
  presence = "online",
  footer,
  size = "sm",
}: {
  children: ReactNode;
  className?: string;
  presence?: string;
  footer?: ReactNode;
  size?: BubbleSize;
}) {
  const lg = size === "lg";

  return (
    <div
      className={cn(
        "on-night flex flex-col overflow-hidden bg-wa-bg ring-1 ring-white/[0.08]",
        lg ? "rounded-[1.5rem] shadow-stage" : "rounded-[1.25rem] shadow-float",
        className
      )}
    >
      {/* WhatsApp's header bar. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-3 bg-wa-head",
          lg ? "px-5 py-3.5" : "px-4 py-3"
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className={cn("shrink-0 text-wa-dim", lg ? "size-5" : "size-5")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>

        <span
          className={cn(
            "grid shrink-0 place-items-center overflow-hidden rounded-full bg-lime",
            lg ? "size-11" : "size-10"
          )}
        >
          <img
            src="/mark.png"
            alt=""
            width={256}
            height={256}
            className={lg ? "size-7" : "size-6"}
          />
        </span>

        <span className="min-w-0 flex-1 leading-tight">
          <span
            className={cn(
              "block truncate font-chat font-semibold text-wa-text",
              lg ? "text-[1.0625rem]" : "text-[0.9375rem]"
            )}
          >
            3rike&nbsp;Pay
          </span>
          <span
            className={cn(
              "block truncate font-chat text-wa-dim",
              lg ? "text-[0.8125rem]" : "text-[0.75rem]"
            )}
          >
            {presence}
          </span>
        </span>

        <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-wa-dim" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </div>

      {/* The thread owns its own scrolling, so it simply takes the space. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", lg ? "px-4 py-4 sm:px-6" : "px-3 py-3 sm:px-4")}>
        {children}
      </div>

      {/* Composer. Inert — it exists so the surface reads as a live chat. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          lg ? "px-4 pb-4 pt-1 sm:px-6" : "px-3 pb-3 pt-1 sm:px-4"
        )}
      >
        <div
          className={cn(
            "flex flex-1 items-center gap-2 rounded-full bg-wa-in",
            lg ? "px-5 py-3" : "px-4 py-2.5"
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className={cn("shrink-0 text-wa-dim", lg ? "size-5" : "size-[1.1rem]")}
            fill="currentColor"
            aria-hidden
          >
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-3.5 7.5a1.3 1.3 0 112.6 0 1.3 1.3 0 01-2.6 0zm4.4 0a1.3 1.3 0 112.6 0 1.3 1.3 0 01-2.6 0zM12 17.3c-2.2 0-4-1.3-4.7-3.2h9.4c-.7 1.9-2.5 3.2-4.7 3.2z" />
          </svg>
          <span
            className={cn(
              "truncate font-chat text-wa-dim",
              lg ? "text-[0.9375rem]" : "text-[0.8125rem]"
            )}
          >
            {footer ?? "Message"}
          </span>
        </div>
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-full bg-green",
            lg ? "size-11" : "size-10"
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className={cn("text-ink", lg ? "size-5" : "size-[1.1rem]")}
            fill="currentColor"
            aria-hidden
          >
            <path d="M3.4 20.4l17.4-7.5a1 1 0 000-1.84L3.4 3.6a1 1 0 00-1.4.92V9.2c0 .5.36.92.85.99l10.2 1.44c.35.05.35.69 0 .74L2.85 13.8a1 1 0 00-.85.99v4.68a1 1 0 001.4.92z" />
          </svg>
        </span>
      </div>
    </div>
  );
}
