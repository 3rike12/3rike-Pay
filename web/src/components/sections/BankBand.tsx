import { Marquee } from "@/components/primitives/Marquee";
import { BANKS } from "@/data/content";

/**
 * Bank availability.
 *
 * Two rows running in opposite directions. No logos: a grid of borrowed marks
 * is both a licensing problem and the single most tired band on any fintech
 * site. Names set as chips instead, which is closer to how you would actually
 * type one into the chat.
 */
export function BankBand() {
  return (
    <section
      aria-labelledby="banks-heading"
      className="on-night relative isolate overflow-hidden bg-night py-14 text-paper md:py-16"
    >
      <div className="shell">
        <h2
          id="banks-heading"
          className="mx-auto max-w-[44ch] text-center text-[0.9375rem] leading-relaxed text-paper/60"
        >
          <span className="font-medium text-paper">Every bank on the NIP network.</span>{" "}
          Short names work too — type{" "}
          <span className="font-mono text-[0.875rem] text-lime">gtb</span>,{" "}
          <span className="font-mono text-[0.875rem] text-lime">zenith</span> or{" "}
          <span className="font-mono text-[0.875rem] text-lime">opay</span>.
        </h2>
      </div>

      <div className="relative mt-9 flex flex-col gap-3 md:mt-11">
        <Marquee
          items={BANKS}
          speed={72}
          separator=""
          gap="gap-3"
          className="text-[0.9375rem] [&_li]:rounded-full [&_li]:border [&_li]:border-white/10 [&_li]:bg-white/[0.045] [&_li]:px-5 [&_li]:py-2.5 [&_li]:text-paper/80"
        />
        <Marquee
          items={[...BANKS].reverse()}
          speed={88}
          reverse
          separator=""
          gap="gap-3"
          className="text-[0.9375rem] [&_li]:rounded-full [&_li]:border [&_li]:border-white/[0.07] [&_li]:bg-white/[0.02] [&_li]:px-5 [&_li]:py-2.5 [&_li]:text-paper/60"
        />

        {/* Feathered edges, so the rows read as continuous rather than cut. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-night to-transparent md:w-32"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-night to-transparent md:w-32"
        />
      </div>
    </section>
  );
}
