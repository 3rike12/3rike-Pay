import { Band, Eyebrow } from "@/components/primitives/Band";
import { Accordion } from "@/components/primitives/Accordion";
import { WhatsAppGlyph } from "@/components/primitives/Button";
import { SUPPORT_EMAIL, WHATSAPP_URL } from "@/lib/site";
import { FAQS } from "@/data/content";

export function Faq({
  items = FAQS,
  title = "Good to know",
}: {
  items?: readonly { q: string; a: string }[];
  title?: string;
}) {
  return (
    <Band id="faq" tone="pure" className="relative overflow-hidden">
      <div
        aria-hidden
        className="dotfield pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_60%_60%_at_20%_20%,black,transparent)]"
      />

      <div className="relative grid gap-10 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>Questions</Eyebrow>
          <h2 className="display-section mt-5 max-w-[10ch] font-display text-balance">
            {title}
          </h2>

          {/* Support, as a card rather than a sentence with a link buried in
              it — this is the one place on the page someone arrives already
              stuck, and it should be the easiest thing to act on. */}
          <div className="mt-8 rounded-[1.25rem] border border-rule bg-paper p-5 shadow-soft">
            <p className="text-[0.9375rem] font-semibold text-ink">Still stuck?</p>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-700">
              Ask in the chat — it is the same place everything else happens.
            </p>

            <a
              href={WHATSAPP_URL}
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-green px-4 py-2.5 text-[0.875rem] font-semibold text-ink shadow-[0_6px_16px_-8px_rgba(1,194,89,0.8)] transition-all duration-300 ease-brand hover:bg-green-hover active:scale-[0.98]"
            >
              <WhatsAppGlyph className="size-4" />
              Chat on WhatsApp
            </a>

            <p className="mt-4 text-[0.8125rem] text-ink-700">
              or write to{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-green-deep underline decoration-green/40 underline-offset-4 transition-colors hover:decoration-green"
              >
                {SUPPORT_EMAIL}
              </a>
            </p>
          </div>
        </div>

        <Accordion items={items} />
      </div>
    </Band>
  );
}
