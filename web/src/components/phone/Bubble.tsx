import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChatLine } from "@/data/chats";

/** `*bold*`, the way WhatsApp renders it. */
function formatted(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((part, index) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
      <strong key={index} className="font-semibold">
        {part.slice(1, -1)}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

export function TypingDots() {
  return (
    <div className="bubble-in w-fit bg-white px-4 py-3">
      <span role="status" aria-label="3rike Pay is typing" className="flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 rounded-full bg-black/40"
            style={{
              animation: "dot-bounce 1.3s ease-in-out infinite",
              animationDelay: `${dot * 0.16}s`,
            }}
          />
        ))}
      </span>
    </div>
  );
}

export function Bubble({ line }: { line: ChatLine }) {
  const outgoing = line.from === "user";

  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "animate-bubble-pop max-w-[85%] px-3 pb-1.5 pt-2",
          outgoing ? "bubble-out bg-[#DCF8C6]" : "bubble-in bg-white",
          "shadow-[0_1px_0.5px_rgba(0,0,0,0.13)]"
        )}
      >
        <p className="whitespace-pre-wrap font-chat text-[0.8125rem] leading-[1.45] text-[#111b21]">
          {formatted(line.text)}
        </p>

        {line.buttons && (
          <div className="-mx-1 mt-2 flex flex-wrap gap-1.5 border-t border-black/5 pt-2">
            {line.buttons.map((label) => (
              <span
                key={label}
                className="rounded-md bg-black/[0.03] px-3 py-1.5 font-chat text-[0.75rem] font-medium text-[#016A99]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {line.flowButton && (
          <div className="-mx-1 mt-2 border-t border-black/5 pt-2">
            <span className="flex items-center justify-center gap-1.5 rounded-md bg-black/[0.03] px-3 py-2 font-chat text-[0.75rem] font-medium text-[#016A99]">
              <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
                <path d="M3 2.5h10a.5.5 0 01.5.5v10a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5zm1.5 2v1.5h7V4.5h-7zm0 3V9h7V7.5h-7z" />
              </svg>
              {line.flowButton}
            </span>
          </div>
        )}

        {/* Timestamp and, on outgoing messages, the read receipt. */}
        <span className="mt-0.5 flex items-center justify-end gap-1">
          <span className="font-chat text-[0.625rem] tabular-nums text-black/55">
            {line.at}
          </span>
          {outgoing && (
            <svg viewBox="0 0 18 12" className="size-[0.85rem] text-[#53BDEB]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1 6.8l3.1 3.2L10.4 2" />
              <path d="M6.6 6.8l3.1 3.2L16 2" />
            </svg>
          )}
        </span>
      </div>
    </div>
  );
}
