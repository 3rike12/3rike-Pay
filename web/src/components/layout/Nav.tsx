import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { WHATSAPP_URL } from "@/lib/site";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { Wordmark } from "./Wordmark";

type NavLink = { label: string; href: string; route?: boolean };

const HOME_LINKS: NavLink[] = [
  { label: "How it works", href: "/#how" },
  { label: "Features", href: "/#features" },
  { label: "Security", href: "/#security" },
  { label: "Questions", href: "/#faq" },
];

const BUSINESS_LINKS: NavLink[] = [
  { label: "Invoices", href: "/business#invoices" },
  { label: "Fees", href: "/business#fees" },
  { label: "Questions", href: "/business#faq" },
];

export function Nav() {
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  const onBusiness = pathname.startsWith("/business");
  const sectionLinks = onBusiness ? BUSINESS_LINKS : HOME_LINKS;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile sheet on navigation, and lock the page behind it.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled || open
          ? "border-b border-hairline bg-paper/85 backdrop-blur-xl"
          : "border-b border-transparent"
      )}
    >
      <nav className="shell flex h-[4.25rem] items-center justify-between gap-6">
        <Wordmark />

        <div className="hidden items-center gap-1 lg:flex">
          {/* Audience switch first — it changes which section links follow. */}
          <Link
            to="/"
            className={cn(
              "rounded-full px-3.5 py-2 text-[0.875rem] font-medium transition-colors",
              !onBusiness ? "bg-green-50 text-green-900" : "text-ink/60 hover:text-ink"
            )}
          >
            Personal
          </Link>
          <Link
            to="/business"
            className={cn(
              "rounded-full px-3.5 py-2 text-[0.875rem] font-medium transition-colors",
              onBusiness ? "bg-green-50 text-green-900" : "text-ink/60 hover:text-ink"
            )}
          >
            Business
          </Link>

          <span className="mx-2 h-5 w-px bg-hairline" />

          {sectionLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-full px-3 py-2 text-[0.875rem] font-medium text-ink/60 transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noreferrer"
            className="bubble-out hidden bg-green px-5 py-2.5 text-[0.875rem] font-semibold text-ink transition-colors hover:bg-lime sm:inline-flex"
          >
            Chat on WhatsApp
          </a>

          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="grid size-10 place-items-center rounded-full border border-hairline lg:hidden"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 12h14" />}
            </svg>
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-hairline bg-paper lg:hidden"
          >
            <div className="shell flex flex-col gap-1 py-5">
              <Link to="/" className="py-2.5 font-display text-[1.375rem] font-bold">
                Personal
              </Link>
              <Link to="/business" className="py-2.5 font-display text-[1.375rem] font-bold">
                Business
              </Link>
              <span className="my-2 h-px bg-hairline" />
              {sectionLinks.map((link) => (
                <a key={link.href} href={link.href} className="py-2 text-ink/65">
                  {link.label}
                </a>
              ))}
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noreferrer"
                className="bubble-out mt-4 bg-green px-5 py-3.5 text-center text-[0.9375rem] font-semibold text-ink"
              >
                Chat on WhatsApp
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
