import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { cn } from "@/lib/cn";
import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { WHATSAPP_URL } from "@/lib/site";
import { WhatsAppGlyph, ArrowGlyph } from "@/components/primitives/Button";
import { DOC_SECTIONS, type Block, type DocSection } from "@/data/docs";

/**
 * The user manual.
 *
 * One section per route rather than one long scroll. Eighteen sections is a
 * forty-minute page if you stack them, and nobody reads a manual that way —
 * they arrive from a search or a support reply wanting one answer. A route
 * each means every answer has its own link, the sidebar always shows where
 * you are, and the reader's position survives a reload.
 *
 * Every bot message quoted here is the real string, formatted the way
 * WhatsApp formats it, so what a reader sees on this page is what they will
 * see in the chat. That is the whole reason the transcripts are styled as
 * threads and not as code blocks.
 */

/* ---------------------------------------------------------------- blocks -- */

/** WhatsApp's own `*bold*`. Same formatter the chat bubbles use. */
function formatted(text: string) {
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

const NOTE_TONES = {
  green: "border-green/35 bg-mint",
  amber: "border-amber/40 bg-amber/[0.09]",
  blue: "border-ink/12 bg-paper-pure",
} as const;

function Note({ title, text, tone = "green" }: { title: string; text: string; tone?: keyof typeof NOTE_TONES }) {
  return (
    <aside className={cn("rounded-[1.25rem] border p-5 md:p-6", NOTE_TONES[tone])}>
      <p className="font-display text-[1.0625rem] font-bold tracking-[-0.02em]">{title}</p>
      <p className="mt-2 text-[0.9375rem] leading-[1.7] text-ink-700">{text}</p>
    </aside>
  );
}

/** A transcript. The reader should recognise it as their own chat window. */
function Chat({ lines }: { lines: { from: "you" | "bot"; text: string }[] }) {
  return (
    <div className="wa-paper flex flex-col gap-2 overflow-hidden rounded-[1.25rem] border border-rule p-3.5 shadow-soft md:p-4">
      {lines.map((line, index) => {
        const outgoing = line.from === "you";
        return (
          <div key={index} className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[92%] px-2.5 py-2 shadow-[0_1px_1px_rgba(11,20,26,0.13)] sm:max-w-[85%]",
                outgoing ? "bubble-out bg-wa-lite-out" : "bubble-in bg-wa-lite-in"
              )}
            >
              <p className="mb-1 font-chat text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-wa-lite-dim">
                {outgoing ? "You" : "3rike Pay"}
              </p>
              <p className="whitespace-pre-wrap font-chat text-[0.8125rem] leading-[1.5] text-wa-lite-text">
                {formatted(line.text)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Table({ head, rows }: { head: readonly string[]; rows: string[][] }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[32rem] border-collapse text-left">
        <thead>
          <tr>
            {head.map((cell) => (
              <th
                key={cell}
                scope="col"
                className="border-b border-ink/15 pb-2.5 pr-5 align-bottom text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink last:pr-0"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    "border-b border-rule py-3.5 pr-5 text-[0.9375rem] leading-[1.65] last:pr-0",
                    cellIndex === 0 ? "font-medium text-ink" : "text-ink-700"
                  )}
                >
                  {formatted(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The arithmetic behind a receipt, lined up so it can be checked. */
function Ledger({ rows, total }: { rows: [string, string][]; total: [string, string] }) {
  return (
    <dl className="overflow-hidden rounded-[1.25rem] border border-rule bg-paper-pure px-5 shadow-soft md:px-6">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-6 border-b border-rule py-3.5"
        >
          <dt className="text-[0.9375rem] text-ink-700">{label}</dt>
          <dd className="tnum text-[0.9375rem] font-medium text-ink">{value}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-6 py-4">
        <dt className="text-[0.9375rem] font-semibold text-ink">{total[0]}</dt>
        <dd className="tnum font-display text-[1.375rem] font-bold tracking-[-0.02em] text-green-deep">
          {total[1]}
        </dd>
      </div>
    </dl>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.k) {
          case "p":
            return (
              <p key={index} className="text-[1rem] leading-[1.75] text-ink-700">
                {formatted(block.text)}
              </p>
            );

          case "h3":
            return (
              <h2
                key={index}
                className="mt-2 font-display text-[1.25rem] font-bold tracking-[-0.02em] md:text-[1.375rem]"
              >
                {block.text}
              </h2>
            );

          case "ul":
            return (
              <ul key={index} className="flex flex-col gap-3">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-3">
                    <span
                      aria-hidden
                      className="mt-[0.5625rem] size-[0.4375rem] shrink-0 rounded-full bg-green"
                    />
                    <span className="text-[1rem] leading-[1.7] text-ink-700">
                      {formatted(item)}
                    </span>
                  </li>
                ))}
              </ul>
            );

          case "steps":
            return (
              <ol key={index} className="flex flex-col gap-5">
                {block.items.map((step, stepIndex) => (
                  <li key={stepIndex} className="flex gap-4">
                    <span className="tnum grid size-7 shrink-0 place-items-center rounded-full bg-green text-[0.8125rem] font-bold text-ink">
                      {stepIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-[1.0625rem] font-bold tracking-[-0.02em]">
                        {step.title}
                      </span>
                      <span className="mt-1 block text-[0.9375rem] leading-[1.7] text-ink-700">
                        {step.text}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            );

          case "chat":
            return <Chat key={index} lines={block.lines} />;

          case "table":
            return <Table key={index} head={block.head} rows={block.rows} />;

          case "ledger":
            return <Ledger key={index} rows={block.rows} total={block.total} />;

          case "note":
            return <Note key={index} title={block.title} text={block.text} tone={block.tone} />;
        }
      })}
    </>
  );
}

/* --------------------------------------------------------------- sidebar -- */

function SideNav({ current, onPick }: { current: DocSection; onPick?: () => void }) {
  return (
    <ol className="flex flex-col gap-0.5">
      {DOC_SECTIONS.map((section) => {
        const active = section.id === current.id;
        return (
          <li key={section.id}>
            <Link
              to={`/doc/${section.id}`}
              onClick={onPick}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-baseline gap-2.5 rounded-xl px-3 py-2 text-[0.875rem] transition-colors duration-200",
                active
                  ? "bg-ink font-semibold text-paper"
                  : "font-medium text-ink-700 hover:bg-ink/[0.055] hover:text-ink"
              )}
            >
              <span
                className={cn(
                  "tnum shrink-0 text-[0.75rem] tabular-nums",
                  // Not `text-grey`: 2.91:1 on paper, which fails AA at 12px.
                  active ? "text-green" : "text-ink-700"
                )}
              >
                {String(section.n).padStart(2, "0")}
              </span>
              <span className="min-w-0">{section.short}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function Doc() {
  const { slug } = useParams();
  const index = slug ? DOC_SECTIONS.findIndex((section) => section.id === slug) : 0;
  const section = index >= 0 ? DOC_SECTIONS[index] : undefined;

  useDocumentMeta({
    title: section ? `${section.title} — 3rike Pay docs` : "Docs — 3rike Pay",
    description: section?.lede
      ? section.lede.slice(0, 155)
      : "How to use 3rike Pay on WhatsApp: setting up, sending money, requesting payment and reading your receipts.",
  });

  // A route change is a new document, so it starts at the top — otherwise you
  // land halfway down section 12 because that is where you were in section 11.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [slug]);

  if (!section) return <Navigate to="/doc" replace />;

  const previous = index > 0 ? DOC_SECTIONS[index - 1] : undefined;
  const next = index < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[index + 1] : undefined;

  return (
    <div className="shell max-w-[82rem] pb-24 pt-28 md:pt-32">
      {/* Masthead. Says what this is and how current it is, once, rather than
          repeating a title on all eighteen pages. */}
      <div className="border-b border-rule pb-8">
        <p className="eyebrow flex items-center gap-2.5 text-green-deep">
          <span aria-hidden className="inline-block h-px w-7 bg-current opacity-50" />
          Documentation
        </p>
        <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-10">
          <h1 className="font-display text-[1.875rem] font-bold tracking-[-0.03em] md:text-[2.25rem]">
            3rike&nbsp;Pay user manual
          </h1>
          <p className="tnum text-[0.8125rem] text-ink-700 md:pb-2">
            Revision 1 · October 2026 · {DOC_SECTIONS.length} sections
          </p>
        </div>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-16">
        {/* ---- Contents ---- */}
        <nav aria-label="Documentation sections" className="lg:sticky lg:top-28 lg:self-start">
          {/* Below lg the eighteen rows would bury the section you came to
              read, so they fold into a disclosure that names where you are. */}
          <details className="group rounded-[1.25rem] border border-rule bg-paper-pure p-2 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="block text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-ink-700">
                  Contents
                </span>
                <span className="mt-0.5 block truncate font-display text-[1rem] font-bold tracking-[-0.02em]">
                  {String(section.n).padStart(2, "0")}. {section.short}
                </span>
              </span>
              <ArrowGlyph
                className="size-3.5 shrink-0 text-ink-700 transition-transform duration-300 group-open:rotate-180"
              />
            </summary>
            <div className="mt-1 border-t border-rule pt-2">
              <SideNav current={section} />
            </div>
          </details>

          <div className="hidden lg:block">
            <p className="px-3 pb-3 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-ink-700">
              Contents
            </p>
            <SideNav current={section} />

            <a
              href={WHATSAPP_URL}
              rel="noreferrer"
              className="mt-5 flex items-center justify-center gap-2 rounded-full bg-green px-4 py-3 text-[0.875rem] font-semibold text-ink transition-colors duration-300 ease-brand hover:bg-green-hover"
            >
              <WhatsAppGlyph className="size-4" />
              Open the chat
            </a>
          </div>
        </nav>

        {/* ---- The section ---- */}
        <article className="min-w-0 max-w-[46rem]">
          <p className="tnum text-[0.8125rem] font-medium text-green-deep">
            Section {section.n} of {DOC_SECTIONS.length}
          </p>
          <h2 className="display-section mt-3 font-display text-balance">{section.title}</h2>

          {section.lede && (
            <p className="mt-5 text-[1.0625rem] leading-[1.7] text-ink md:text-[1.125rem]">
              {formatted(section.lede)}
            </p>
          )}

          <div className="mt-10 flex flex-col gap-6">
            <Blocks blocks={section.blocks} />
          </div>

          {/* ---- Prev / next ---- */}
          <div className="mt-16 grid gap-3 border-t border-rule pt-8 sm:grid-cols-2">
            {previous ? (
              <Link
                to={`/doc/${previous.id}`}
                className="lift group flex flex-col gap-1 rounded-[1.25rem] border border-rule bg-paper-pure p-5 hover:border-ink/15"
              >
                <span className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-700">
                  Previous
                </span>
                <span className="font-display text-[1.0625rem] font-bold tracking-[-0.02em]">
                  {previous.title}
                </span>
              </Link>
            ) : (
              <span aria-hidden />
            )}

            {next && (
              <Link
                to={`/doc/${next.id}`}
                className="lift group flex flex-col gap-1 rounded-[1.25rem] border border-rule bg-paper-pure p-5 text-right hover:border-ink/15 sm:col-start-2"
              >
                <span className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-700">
                  Next
                </span>
                <span className="font-display text-[1.0625rem] font-bold tracking-[-0.02em]">
                  {next.title}
                </span>
              </Link>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
