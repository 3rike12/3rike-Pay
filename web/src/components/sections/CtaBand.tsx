import { Composer } from "@/components/primitives/Composer";

/**
 * The closing band. It repeats the hero's composer deliberately: the page
 * opened by asking you to send a message and it closes the same way, so the
 * one idea on the site is also the last thing on it.
 */
export function CtaBand({
  title = "Your bank is a message away.",
  body = "Say hi. Verify once. Send money from the app you already have open.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <section className="on-dark relative overflow-hidden bg-ink py-24 text-paper md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[-45%] left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-green/20 blur-[130px]"
      />
      <div className="shell relative flex flex-col items-center text-center">
        <h2 className="display-lg max-w-[22ch]">{title}</h2>
        <p className="mt-6 max-w-[44ch] text-[1.0625rem] leading-relaxed text-grey-300">
          {body}
        </p>
        <div className="mt-10 flex w-full justify-center">
          <Composer tone="dark" />
        </div>
      </div>
    </section>
  );
}
