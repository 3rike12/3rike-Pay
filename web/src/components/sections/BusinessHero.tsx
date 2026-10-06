import { Composer } from "@/components/primitives/Composer";
import { Ticks } from "@/components/primitives/Ticks";
import { ChatThread } from "@/components/phone/ChatThread";
import { PhoneFrame } from "@/components/phone/PhoneFrame";
import { invoiceScript } from "@/data/chats";

export function BusinessHero() {
  return (
    <section className="relative overflow-hidden pb-16 pt-32 md:pb-24 md:pt-40">
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-12%] top-[6%] size-[34rem] rounded-full bg-green-50 blur-[100px] md:size-[42rem]"
      />

      <div className="shell relative grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
        <div>
          <p className="stamp mb-5">For shops, traders and anyone who invoices</p>
          <h1 className="display-xl max-w-[17ch]">Bill a customer in one message.</h1>

          <p className="lede mt-7 text-ink/65">
            Raise an itemised invoice in the same chat you use to talk to them.
            The payment prompt lands on their phone, and the money lands in your
            wallet.
          </p>

          <div className="mt-9">
            <Composer />
            <p className="stamp mt-3 pl-5">
              No terminal to rent. No checkout page to build.
            </p>
          </div>

          <ul className="mt-10 flex flex-col gap-2.5 border-t border-hairline pt-7 sm:flex-row sm:flex-wrap sm:gap-x-7">
            {["Itemised invoices", "Saved catalogue", "Fees shown line by line"].map(
              (item) => (
                <li key={item} className="flex items-center gap-2 text-[0.9375rem] text-ink/70">
                  <Ticks className="text-green" />
                  {item}
                </li>
              )
            )}
          </ul>
        </div>

        <div className="flex justify-center lg:justify-end">
          <PhoneFrame presence="business account">
            <ChatThread script={invoiceScript} />
          </PhoneFrame>
        </div>
      </div>
    </section>
  );
}
