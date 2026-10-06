import { Heading, Section } from "@/components/primitives/Section";
import { Ticks } from "@/components/primitives/Ticks";
import { SECURITY } from "@/data/content";

/**
 * The second dark band. Every claim here describes a mechanism that actually
 * exists — SECURITY in data/content.ts records which file implements each one,
 * so the copy can be re-checked when the code changes. The paths stay out of
 * the page: the audience is people sending ₦5,000, not reviewers.
 */
export function Security() {
  return (
    <Section id="security" tone="ink">
      <div className="grid gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
        <Heading
          tone="dark"
          title="Four things stand between your money and someone else."
          body="Not a padlock icon and the word bank-grade. These are the actual mechanisms, described plainly so you can judge them."
        />

        <ul className="flex flex-col">
          {SECURITY.map((item) => (
            <li
              key={item.title}
              className="flex gap-5 border-t border-hairline-dark py-7 first:border-t-0 first:pt-0"
            >
              <Ticks className="mt-1 text-green" />
              <div>
                <h3 className="font-sans text-[1.0625rem] font-semibold tracking-[-0.01em] text-paper">
                  {item.title}
                </h3>
                <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-grey-400">
                  {item.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
