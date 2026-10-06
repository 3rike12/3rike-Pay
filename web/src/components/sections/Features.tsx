import { Heading, Section } from "@/components/primitives/Section";
import { ChatThread } from "@/components/phone/ChatThread";
import { cn } from "@/lib/cn";
import { balanceScript } from "@/data/chats";
import { FEATURES } from "@/data/content";
import type { Feature } from "@/data/content";

const tones = {
  paper: "border border-hairline bg-paper text-ink",
  tint: "bg-green-50 text-green-900",
  lime: "bg-lime text-green-900",
  ink: "on-dark bg-ink text-paper",
} as const;

const bodyTones = {
  paper: "text-ink/65",
  tint: "text-green-900/85",
  lime: "text-green-900/85",
  ink: "text-grey-300",
} as const;

function Tile({ feature }: { feature: Feature }) {
  return (
    <article
      className={cn(
        "bubble-in-lg flex flex-col p-7 md:p-8",
        tones[feature.tone],
        feature.span === "wide" && "md:col-span-2"
      )}
    >
      <h3 className="font-display text-[1.3125rem] font-bold leading-[1.15] tracking-[-0.02em] md:text-[1.5rem]">
        {feature.title}
      </h3>
      <p
        className={cn(
          "mt-3 max-w-[42ch] text-[0.9375rem] leading-relaxed",
          bodyTones[feature.tone]
        )}
      >
        {feature.body}
      </p>
    </article>
  );
}

/**
 * A bento, not a row of identical cards. The wide tiles carry the two claims
 * that matter most; the balance thread sits inside the layout as a working
 * example rather than as a picture next to one.
 *
 * Tile order is load-bearing: the balance tile spans two rows, so it must come
 * second for the grid to close up without holes.
 */
export function Features() {
  const [lead, ...rest] = FEATURES;

  return (
    <Section id="features">
      <Heading
        at="12:04"
        title="What you can do without opening an app."
        body="Everything here happens in the thread. No screens to learn, no tabs, no second device."
      />

      <div className="mt-14 grid gap-4 md:grid-cols-3">
        <Tile feature={lead} />

        <article className="bubble-out-lg flex flex-col bg-mist p-7 md:row-span-2 md:p-8">
          <h3 className="font-display text-[1.3125rem] font-bold leading-[1.15] tracking-[-0.02em] md:text-[1.5rem]">
            Ask, and it is a reply
          </h3>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink/65">
            One word gets you both balances — your wallet, and the bank account
            issued to you when you signed up.
          </p>
          <div className="mt-7 rounded-2xl bg-[#ECE5DD] p-3">
            <ChatThread script={balanceScript} />
          </div>
        </article>

        {rest.map((feature) => (
          <Tile key={feature.title} feature={feature} />
        ))}
      </div>
    </Section>
  );
}
