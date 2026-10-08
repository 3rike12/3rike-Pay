import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChatLine } from "@/data/chats";

/**
 * WhatsApp's *light* theme, which is what most Nigerian phones are actually
 * set to and what suits a page section printed on paper.
 *
 * Kept separate from `Bubble` rather than folded into it as a tone flag: the
 * dark build carries receipts, flow buttons and read ticks that the light one
 * does not need, and a single component serving both ends up as a matrix of
 * conditionals that is harder to read than two short files.
 */
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

function LiteTicks() {
  return (
    <svg
      viewBox="0 0 18 12"
      className="size-[0.85rem] text-[#53bdeb]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 6.6l3.2 3.3L10.5 1.8" />
      <path d="M6.8 6.6l3.2 3.3L16.3 1.8" />
    </svg>
  );
}

export function LiteBubble({ line }: { line: ChatLine }) {
  const outgoing = line.from === "user";

  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] px-2 pb-1 pt-1.5 shadow-[0_1px_1px_rgba(11,20,26,0.13)]",
          outgoing ? "bubble-out bg-wa-lite-out" : "bubble-in bg-wa-lite-in"
        )}
      >
        {line.receipt ? (
          <div className="w-full overflow-hidden rounded-[9px] border border-black/5">
            <div className="flex items-center gap-2 bg-green px-3 py-2">
              <svg
                viewBox="0 0 14 14"
                className="size-3.5 text-ink"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M2.2 7.4l3.1 3.2L11.8 3.6" />
              </svg>
              <span className="font-chat text-[0.8125rem] font-semibold text-ink">
                {line.receipt.label}
              </span>
            </div>
            <dl className="divide-y divide-black/[0.06] bg-white px-3">
              {line.receipt.rows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-4 py-[0.4375rem]">
                  <dt className="font-chat text-[0.75rem] text-wa-lite-dim">{label}</dt>
                  <dd className="tnum font-chat text-[0.8125rem] font-semibold text-wa-lite-text">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <p className="whitespace-pre-wrap px-1 font-chat text-[0.8125rem] leading-[1.45] text-wa-lite-text">
            {formatted(line.text)}
          </p>
        )}

        {line.buttons && (
          <div className="mt-1.5 flex flex-col gap-px overflow-hidden rounded-[8px]">
            {line.buttons.map((label) => (
              <span
                key={label}
                className="bg-black/[0.045] px-3 py-2 text-center font-chat text-[0.75rem] font-medium text-[#0a6a94]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        <span className="mt-0.5 flex items-center justify-end gap-1 px-1 pb-0.5">
          <span className="tnum font-chat text-[0.625rem] text-wa-lite-dim">{line.at}</span>
          {outgoing && <LiteTicks />}
        </span>
      </div>
    </div>
  );
}
