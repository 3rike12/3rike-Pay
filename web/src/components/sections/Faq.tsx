import { Accordion } from "@/components/primitives/Accordion";
import { Heading, Section } from "@/components/primitives/Section";
import { SUPPORT_EMAIL } from "@/lib/site";

export function Faq({
  items,
  title = "Questions people ask first.",
}: {
  items: readonly { q: string; a: string }[];
  title?: string;
}) {
  return (
    <Section id="faq">
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div>
          <Heading title={title} />
          <p className="mt-6 text-[0.9375rem] text-ink/60">
            Something not here?{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="font-medium text-green-700 underline decoration-green/40 underline-offset-4 hover:decoration-green"
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
        <Accordion items={items} />
      </div>
    </Section>
  );
}
