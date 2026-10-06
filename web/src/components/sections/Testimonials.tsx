import { Heading, Section } from "@/components/primitives/Section";
import { Reveal } from "@/components/primitives/Reveal";
import { cn } from "@/lib/cn";
import { TESTIMONIALS } from "@/data/content";

/** Initials in a chat bubble, the same mark language as the logo. */
function Avatar({ name, index }: { name: string; index: number }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);

  // Alternating fills keep the column from reading as one flat block.
  const fills = ["bg-green text-ink", "bg-lime text-green-900", "bg-ink text-paper"];

  return (
    <span
      aria-hidden
      className={cn(
        "bubble-in grid size-9 shrink-0 place-items-center font-display text-[0.8125rem] font-bold",
        fills[index % fills.length]
      )}
    >
      {initials}
    </span>
  );
}

export function Testimonials() {
  return (
    <Section tone="mist">
      <Heading
        title="People stopped opening their banking app."
        body="The same thing comes up every time: it is one less thing to install, and one less password to remember."
      />

      {/* A masonry column flow — the quotes are different lengths and the
          layout lets them be, rather than padding them into equal boxes. */}
      <div className="mt-14 gap-4 md:columns-2 lg:columns-3 [&>*]:mb-4">
        {TESTIMONIALS.map((item, index) => (
          <Reveal key={item.name} delay={(index % 3) * 0.06}>
            <figure className="bubble-in-lg break-inside-avoid border border-hairline bg-paper p-6">
              <blockquote className="text-[0.9375rem] leading-relaxed text-ink/80">
                {item.quote}
              </blockquote>
              <figcaption className="mt-5 flex items-center gap-3">
                <Avatar name={item.name} index={index} />
                <span className="leading-tight">
                  <span className="block text-[0.875rem] font-semibold">{item.name}</span>
                  <span className="stamp">{item.handle}</span>
                </span>
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
