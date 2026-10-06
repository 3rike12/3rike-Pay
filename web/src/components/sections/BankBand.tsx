import { Marquee } from "@/components/primitives/Marquee";
import { BANKS } from "@/data/content";

/**
 * The first dark band. Instead of a row of headline statistics — the default
 * treatment for this slot — it names the banks money actually lands in, which
 * is the thing a person wants confirmed before they trust a chat with ₦5,000.
 */
export function BankBand() {
  return (
    <section className="on-dark overflow-hidden bg-ink py-14 text-paper md:py-16">
      <div className="shell">
        <h2 className="display-md max-w-[26ch]">
          It lands in the bank they already use.
        </h2>
        <p className="mt-3 max-w-[48ch] text-[0.9375rem] text-grey-400">
          Traditional banks and the apps people actually keep money in. If they
          can receive a transfer, you can send them one from a chat.
        </p>
      </div>

      <Marquee items={BANKS} className="mt-10" />
    </section>
  );
}
