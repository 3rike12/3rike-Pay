import { Composer } from "@/components/primitives/Composer";
import { Ticks } from "@/components/primitives/Ticks";
import { ChatThread } from "@/components/phone/ChatThread";
import { PhoneFrame } from "@/components/phone/PhoneFrame";
import { sendMoneyScript } from "@/data/chats";

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-16 pt-32 md:pb-24 md:pt-40">
      {/* One soft lime wash, sitting behind the handset. The only decoration
          on the page that isn't carrying information. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-30%] top-[2%] size-[22rem] rounded-full bg-lime/30 blur-[90px] md:right-[-12%] md:top-[6%] md:size-[42rem] md:bg-lime/55 md:blur-[110px]"
      />

      <div className="shell relative grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
        <div>
          <h1 className="display-xl max-w-[15ch]">
            Send money the way you&rsquo;d say it.
          </h1>

          <p className="lede mt-7 text-ink/65">
            Type one line in WhatsApp and it reaches any Nigerian bank account.
            Nothing to download, nothing to fill in, nobody to log in as.
          </p>

          <div className="mt-9">
            <Composer />
            <p className="stamp mt-3 pl-5">
              Opens WhatsApp. Verifying takes under two minutes.
            </p>
          </div>

          <ul className="mt-10 flex flex-col gap-2.5 border-t border-hairline pt-7 sm:flex-row sm:flex-wrap sm:gap-x-7">
            {[
              "Any Nigerian bank",
              "Your own account number",
              "PIN on every send",
            ].map((item) => (
              <li
                key={item}
                className="flex items-center gap-2 text-[0.9375rem] text-ink/70"
              >
                <Ticks className="text-green" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-center lg:justify-end">
          <PhoneFrame>
            <ChatThread script={sendMoneyScript} />
          </PhoneFrame>
        </div>
      </div>
    </section>
  );
}
