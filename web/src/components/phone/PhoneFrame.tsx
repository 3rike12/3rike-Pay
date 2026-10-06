import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A handset holding a WhatsApp conversation.
 *
 * Deliberately not a photorealistic iPhone render — a plain dark frame with a
 * real WhatsApp chrome inside reads as the product rather than as a stock
 * mockup. Any `children` can sit in the screen, so a real screenshot can
 * replace the scripted chat later without touching this component.
 */
export function PhoneFrame({
  children,
  className,
  presence = "online",
}: {
  children: ReactNode;
  className?: string;
  presence?: string;
}) {
  return (
    <div
      className={cn(
        "relative w-full max-w-[21rem] rounded-[2.5rem] bg-ink p-2.5 shadow-[0_32px_80px_-24px_rgba(10,10,10,0.35)]",
        className
      )}
    >
      <div className="overflow-hidden rounded-[2rem] bg-[#ECE5DD]">
        {/* WhatsApp's own header bar. */}
        <div className="flex items-center gap-3 bg-[#075E54] px-4 pb-3 pt-4">
          <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-white/80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>

          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-green font-display text-[0.9375rem] font-bold text-white">
            3
          </span>

          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate font-chat text-[0.9375rem] font-semibold text-white">
              3rike Pay
            </span>
            <span className="block truncate font-chat text-[0.6875rem] text-white/70">
              {presence}
            </span>
          </span>

          <svg viewBox="0 0 24 24" className="size-[1.1rem] shrink-0 text-white/70" fill="currentColor" aria-hidden>
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </div>

        {/* The thread. */}
        <div className="min-h-[24rem] px-3 py-4">{children}</div>

        {/* Composer, inert — it exists so the screen reads as a real chat. */}
        <div className="flex items-center gap-2 bg-[#ECE5DD] px-3 pb-3.5 pt-1">
          <div className="flex-1 rounded-full bg-white px-4 py-2.5 font-chat text-[0.8125rem] text-black/55">
            Message
          </div>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#075E54]">
            <svg viewBox="0 0 24 24" className="size-4 text-white" fill="currentColor" aria-hidden>
              <path d="M12 15.5a3.5 3.5 0 003.5-3.5V6a3.5 3.5 0 10-7 0v6a3.5 3.5 0 003.5 3.5z" />
              <path d="M18.5 11.5a.9.9 0 00-1.8 0 4.7 4.7 0 11-9.4 0 .9.9 0 00-1.8 0 6.5 6.5 0 005.6 6.44V20H9.5a.9.9 0 000 1.8h5a.9.9 0 000-1.8h-1.6v-2.06a6.5 6.5 0 005.6-6.44z" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
