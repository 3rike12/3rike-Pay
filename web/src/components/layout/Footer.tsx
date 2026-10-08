import { Link } from "react-router-dom";
import { WhatsAppGlyph } from "@/components/primitives/Button";
import { SOCIALS, SUPPORT_EMAIL, WHATSAPP_URL } from "@/lib/site";
import { Wordmark } from "./Wordmark";

const COLUMNS = [
  {
    heading: "Personal",
    links: [
      { label: "How it works", href: "/#how" },
      { label: "What you can do", href: "/#features" },
      { label: "Safety", href: "/#security" },
      { label: "Questions", href: "/#faq" },
    ],
  },
  {
    heading: "Business",
    links: [
      { label: "Getting paid", href: "/business#flow" },
      { label: "Fees", href: "/business#fees" },
      { label: "Questions", href: "/business#faq" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Terms of use", href: "/terms", route: true },
      { label: "Privacy policy", href: "/privacy", route: true },
    ],
  },
] as const;

/**
 * The footer.
 *
 * It opens with the one action the whole page has been asking for rather than
 * burying it under four columns of links — a contact panel with the chat
 * button and the support address, set apart on its own ground. The navigation
 * follows, and the page signs off on the wordmark at display scale, clipped
 * by the bottom edge so it reads as a sign-off rather than a watermark
 * someone forgot to delete.
 */
export function Footer() {
  return (
    <footer className="on-night relative isolate overflow-hidden bg-night-deep text-paper">
      <div className="shell pt-16 md:pt-20">
        {/* ---- The ask ---- */}
        <div className="flex flex-col gap-7 rounded-[1.75rem] border border-rule-dark bg-night-soft/60 p-7 md:flex-row md:items-center md:justify-between md:gap-12 md:p-9">
          <div className="max-w-[34rem]">
            <Wordmark tone="dark" />
            <p className="mt-4 text-[1rem] leading-relaxed text-paper/60">
              Money that moves from inside the conversation you were already
              having. Built for Nigeria, on WhatsApp.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a
              href={WHATSAPP_URL}
              rel="noreferrer"
              className="inline-flex items-center gap-2.5 rounded-full bg-green px-5 py-3 text-[0.9375rem] font-semibold text-ink shadow-[0_8px_22px_-10px_rgba(1,194,89,0.9)] transition-all duration-300 ease-brand hover:bg-green-hover active:scale-[0.98]"
            >
              <WhatsAppGlyph />
              Chat on WhatsApp
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="inline-flex items-center rounded-full border border-paper/20 px-5 py-3 text-[0.9375rem] text-paper/80 transition-colors duration-200 hover:border-paper/50 hover:text-paper"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
        </div>

        {/* ---- Navigation ---- */}
        <div className="grid gap-10 py-12 sm:grid-cols-3 md:py-14">
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="eyebrow text-paper/60">{column.heading}</h2>
              <ul className="mt-5 flex flex-col gap-3">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {"route" in link && link.route ? (
                      <Link
                        to={link.href}
                        className="group inline-flex items-center gap-2 text-[0.9375rem] text-paper/60 transition-colors hover:text-lime"
                      >
                        <span
                          aria-hidden
                          className="h-px w-0 bg-lime transition-all duration-300 ease-brand group-hover:w-3.5"
                        />
                        {link.label}
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        className="group inline-flex items-center gap-2 text-[0.9375rem] text-paper/60 transition-colors hover:text-lime"
                      >
                        <span
                          aria-hidden
                          className="h-px w-0 bg-lime transition-all duration-300 ease-brand group-hover:w-3.5"
                        />
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* ---- Fine print ---- */}
        <div className="flex flex-col gap-5 border-t border-rule-dark py-7 md:flex-row md:items-center md:justify-between">
          <p className="max-w-[46ch] text-[0.8125rem] leading-relaxed text-paper/50">
            © {new Date().getFullYear()} 3rike. Transfers are processed by
            licensed partner institutions.
          </p>

          <ul className="flex items-center gap-2">
            {SOCIALS.map((social) => (
              <li key={social.label}>
                <a
                  href={social.href}
                  rel="noreferrer"
                  className="inline-flex items-center rounded-full border border-rule-dark px-4 py-2 text-[0.8125rem] text-paper/60 transition-colors duration-200 hover:border-lime/50 hover:text-lime"
                >
                  {social.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ---- The sign-off ----
          The wordmark at display scale, clipped by the bottom of the page and
          faded into it. Purely decorative: the same name is set in full
          contrast twice above, so nothing is carried by this alone. */}
      <p
        aria-hidden
        className="pointer-events-none mt-2 select-none overflow-hidden whitespace-nowrap px-5 text-center font-display text-[clamp(4rem,17vw,15rem)] font-extrabold leading-[0.74] tracking-[-0.055em] text-paper/40 [mask-image:linear-gradient(to_bottom,black_15%,transparent_92%)] md:px-8"
        style={{ height: "0.56em" }}
      >
        3rike Pay
      </p>
    </footer>
  );
}
