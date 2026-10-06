import { Link } from "react-router-dom";
import { SOCIALS, SUPPORT_EMAIL, WHATSAPP_URL } from "@/lib/site";
import { Wordmark } from "./Wordmark";

const COLUMNS = [
  {
    heading: "Personal",
    links: [
      { label: "How it works", href: "/#how" },
      { label: "Features", href: "/#features" },
      { label: "Security", href: "/#security" },
      { label: "Questions", href: "/#faq" },
    ],
  },
  {
    heading: "Business",
    links: [
      { label: "Invoices", href: "/business#invoices" },
      { label: "Catalogue", href: "/business#catalogue" },
      { label: "Fees", href: "/business#fees" },
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

export function Footer() {
  return (
    <footer className="on-dark bg-ink pb-10 pt-16 text-paper md:pt-20">
      <div className="shell">
        <div className="grid gap-12 border-b border-hairline-dark pb-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Wordmark tone="dark" />
            <p className="mt-5 max-w-[30ch] text-[0.9375rem] leading-relaxed text-grey-400">
              Money that moves from inside the conversation you are already
              having. Built for Nigeria, on WhatsApp.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="font-sans text-[0.9375rem] font-semibold text-paper">
                {column.heading}
              </h2>
              <ul className="mt-4 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {"route" in link && link.route ? (
                      <Link
                        to={link.href}
                        className="text-[0.9375rem] text-grey-400 transition-colors hover:text-lime"
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        className="text-[0.9375rem] text-grey-400 transition-colors hover:text-lime"
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-col gap-6 pt-8 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[0.875rem] font-medium text-lime hover:underline"
            >
              Chat on WhatsApp
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-[0.875rem] text-grey-400 transition-colors hover:text-paper"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          <div className="flex items-center gap-5">
            {SOCIALS.map((social) => (
              <a
                key={social.label}
                href={social.href}
                target="_blank"
                rel="noreferrer"
                className="text-[0.875rem] text-grey-400 transition-colors hover:text-paper"
              >
                {social.label}
              </a>
            ))}
          </div>
        </div>

        <p className="stamp mt-8 text-grey-400">
          © {new Date().getFullYear()} 3rike. Transfers are processed by licensed
          partner institutions.
        </p>
      </div>
    </footer>
  );
}
