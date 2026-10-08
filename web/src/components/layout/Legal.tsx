import type { ReactNode } from "react";

/**
 * Shared shell for the legal pages. Narrow measure, generous leading — these
 * are the only pages on the site meant to be read start to finish.
 */
export function Legal({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="shell max-w-[46rem] pb-24 pt-32 md:pt-40">
      <p className="tnum mb-5 text-[0.8125rem] text-ink-700">Last updated {updated}</p>
      <h1 className="display-section font-display">{title}</h1>

      <div
        className="
          mt-12 flex flex-col gap-10
          [&_h2]:font-display [&_h2]:text-[1.375rem] [&_h2]:font-bold [&_h2]:tracking-[-0.02em]
          [&_li]:text-ink-700 [&_p]:text-ink-700
          [&_p]:leading-[1.75] [&_li]:leading-[1.75]
          [&_a]:font-medium [&_a]:text-green-deep [&_a]:underline [&_a]:decoration-green/40 [&_a]:underline-offset-4
          [&_section]:flex [&_section]:flex-col [&_section]:gap-3
          [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5
        "
      >
        {children}
      </div>
    </article>
  );
}
