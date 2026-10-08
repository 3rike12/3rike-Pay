import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChatLine } from "@/data/chats";

export type BubbleSize = "sm" | "lg";

/** `*bold*`, the way WhatsApp renders it. */
function formatted(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((part, index) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
      <strong key={index} className="font-semibold text-white">
        {part.slice(1, -1)}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

export function TypingDots({ size = "sm" }: { size?: BubbleSize }) {
  return (
    <div className="flex justify-start">
      <div className={cn("bubble-in w-fit bg-wa-in", size === "lg" ? "px-4 py-3.5" : "px-3.5 py-3")}>
        <span role="status" aria-label="3rike Pay is typing" className="flex items-center gap-1">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className={cn("rounded-full bg-wa-dim", size === "lg" ? "size-2" : "size-1.5")}
              style={{
                animation: "dot-bounce 1.3s ease-in-out infinite",
                animationDelay: `${dot * 0.16}s`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function Ticks({ size }: { size: BubbleSize }) {
  return (
    <svg
      viewBox="0 0 18 12"
      className={cn("animate-tick-in text-wa-tick", size === "lg" ? "size-4" : "size-[0.9rem]")}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 6.6l3.2 3.3L10.5 1.8" />
      <path d="M6.8 6.6l3.2 3.3L16.3 1.8" />
    </svg>
  );
}

/**
 * The receipt card.
 *
 * WhatsApp has no such primitive — this is how the product's own confirmation
 * reads once the figures matter, and it is the one place the thread is allowed
 * to look designed rather than typed.
 */
function Receipt({
  receipt,
  size,
}: {
  receipt: NonNullable<ChatLine["receipt"]>;
  size: BubbleSize;
}) {
  const lg = size === "lg";

  return (
    <div className="w-full overflow-hidden rounded-[10px] bg-black/25">
      <div className={cn("flex items-center gap-2 bg-wa-out", lg ? "px-4 py-3" : "px-3.5 py-2.5")}>
        <span
          className={cn("grid place-items-center rounded-full bg-lime", lg ? "size-[1.375rem]" : "size-5")}
        >
          <svg
            viewBox="0 0 14 14"
            className={cn("text-green-ink", lg ? "size-3.5" : "size-3")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M2.2 7.4l3.1 3.2L11.8 3.6" />
          </svg>
        </span>
        <span
          className={cn(
            "font-chat font-semibold text-white",
            lg ? "text-[0.9375rem]" : "text-[0.8125rem]"
          )}
        >
          {receipt.label}
        </span>
      </div>

      <dl className={cn("divide-y divide-white/[0.07]", lg ? "px-4" : "px-3.5")}>
        {receipt.rows.map(([label, value]) => (
          <div
            key={label}
            className={cn(
              "flex items-baseline justify-between gap-4",
              lg ? "py-2.5" : "py-[0.4375rem]"
            )}
          >
            <dt className={cn("font-chat text-wa-dim", lg ? "text-[0.8125rem]" : "text-[0.75rem]")}>
              {label}
            </dt>
            <dd
              className={cn(
                "tnum font-chat font-medium text-wa-text",
                lg ? "text-[0.9375rem]" : "text-[0.8125rem]"
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Bubble({
  line,
  animate = true,
  size = "sm",
}: {
  line: ChatLine;
  animate?: boolean;
  size?: BubbleSize;
}) {
  const outgoing = line.from === "user";
  const lg = size === "lg";

  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "shadow-[0_1px_1px_rgba(0,0,0,0.25)]",
          lg
            ? "max-w-[min(82%,27rem)] px-3 pb-1.5 pt-2"
            : "max-w-[min(85%,19.5rem)] px-2.5 pb-1 pt-1.5",
          line.receipt && (lg ? "w-[min(23rem,86%)] px-2 pt-2" : "w-[min(17.5rem,88%)] px-1.5 pt-1.5"),
          outgoing ? "bubble-out bg-wa-out" : "bubble-in bg-wa-in",
          animate && "animate-bubble-rise"
        )}
      >
        {line.receipt ? (
          <Receipt receipt={line.receipt} size={size} />
        ) : (
          <p
            className={cn(
              "whitespace-pre-wrap px-1 font-chat text-wa-text",
              lg ? "text-[1rem] leading-[1.5]" : "text-[0.8125rem] leading-[1.45]"
            )}
          >
            {formatted(line.text)}
          </p>
        )}

        {line.buttons && (
          <div className={cn("flex flex-col gap-px overflow-hidden rounded-[8px]", lg ? "mt-2" : "mt-1.5")}>
            {line.buttons.map((label) => (
              <span
                key={label}
                className={cn(
                  "bg-white/[0.06] text-center font-chat font-medium text-wa-link",
                  lg ? "px-3 py-2.5 text-[0.875rem]" : "px-3 py-2 text-[0.75rem]"
                )}
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {line.flowButton && (
          <div className={cn("overflow-hidden rounded-[8px]", lg ? "mt-2" : "mt-1.5")}>
            <span
              className={cn(
                "flex items-center justify-center gap-1.5 bg-white/[0.06] font-chat font-medium text-wa-link",
                lg ? "px-3 py-2.5 text-[0.875rem]" : "px-3 py-2 text-[0.75rem]"
              )}
            >
              <svg viewBox="0 0 16 16" className={lg ? "size-3.5" : "size-3"} fill="currentColor" aria-hidden>
                <path d="M3 2.5h10a.5.5 0 01.5.5v10a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5zm1.5 2v1.5h7V4.5h-7zm0 3V9h7V7.5h-7z" />
              </svg>
              {line.flowButton}
            </span>
          </div>
        )}

        <span className="mt-0.5 flex items-center justify-end gap-1 px-1 pb-0.5">
          <span
            className={cn(
              "tnum font-chat",
              lg ? "text-[0.6875rem]" : "text-[0.625rem]",
              outgoing ? "text-wa-text/80" : "text-wa-dim"
            )}
          >
            {line.at}
          </span>
          {outgoing && <Ticks size={size} />}
        </span>
      </div>
    </div>
  );
}
