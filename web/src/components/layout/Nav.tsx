import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { WHATSAPP_URL } from "@/lib/site";
import { WhatsAppGlyph } from "@/components/primitives/Button";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { Wordmark } from "./Wordmark";

const HOME_LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "What you can do", href: "/#features" },
  { label: "Safety", href: "/#security" },
  { label: "Questions", href: "/#faq" },
];

const BUSINESS_LINKS = [
  { label: "Getting paid", href: "/business#flow" },
  { label: "Fees", href: "/business#fees" },
  { label: "Questions", href: "/business#faq" },
];

/**
 * Full-width at rest, a floating capsule once you move.
 *
 * At the top it is a bare row spanning the content measure, aligned with the
 * hero beneath it. Scroll and it draws in — narrower, shorter, and backed by
 * glass. Only a width, a height and a background animate; nothing inside
 * reflows, which is what keeps the change from reading as a jolt.
 *
 * Over the home hero the ground is a photograph, so while the bar is still
 * transparent its type reverses to paper and goes back to ink as the capsule
 * closes under it.
 */
export function Nav() {
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  const onBusiness = pathname.startsWith("/business");
  const solid = scrolled || open;
  // The only page whose first screen is dark. Everywhere else the bare bar
  // sits on paper and the type stays as it is.
  const onDark = !solid && pathname === "/";
  const links = onBusiness ? BUSINESS_LINKS : HOME_LINKS;
  const other = onBusiness
    ? { label: "Personal", to: "/" }
    : { label: "For business", to: "/business" };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={cn(
          "pointer-events-auto mx-auto flex items-center justify-between gap-6 rounded-full px-4 transition-all duration-[600ms] ease-brand sm:px-5",
          solid
            ? "h-[3.5rem] max-w-[62rem] border border-rule bg-paper/80 shadow-float backdrop-blur-xl"
            : "h-[4.25rem] max-w-[78rem] border border-transparent bg-transparent"
        )}
      >
        <Wordmark tone={onDark ? "dark" : "light"} />

        <ul className="hidden items-center gap-1 lg:flex">
          {links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className={cn(
                  "rounded-full px-3.5 py-2 text-[0.875rem] font-medium transition-colors duration-200",
                  onDark
                    ? "text-paper hover:bg-paper/15"
                    : "text-ink-700 hover:bg-ink/[0.055] hover:text-ink"
                )}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            to={other.to}
            className={cn(
              "hidden rounded-full px-3 py-2 text-[0.875rem] font-medium transition-colors duration-200 md:block",
              onDark
                ? "text-paper hover:bg-paper/15"
                : "text-ink-700 hover:bg-ink/[0.055] hover:text-ink"
            )}
          >
            {other.label}
          </Link>

          <a
            href={WHATSAPP_URL}
            rel="noreferrer"
            className="hidden items-center gap-2 rounded-full bg-green px-4 py-2.5 text-[0.875rem] font-semibold text-ink shadow-[0_6px_16px_-8px_rgba(1,194,89,0.8)] transition-all duration-300 ease-brand hover:bg-green-hover active:scale-[0.98] sm:inline-flex"
          >
            <WhatsAppGlyph className="size-4" />
            Chat on WhatsApp
          </a>

          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className={cn(
              "grid size-10 cursor-pointer place-items-center rounded-full border transition-colors duration-200 lg:hidden",
              open && "border-ink/25 bg-ink/[0.06]",
              !open && onDark && "border-paper/30 bg-paper/10 text-paper",
              !open && !onDark && "border-rule bg-paper/70"
            )}
          >
            <svg
              viewBox="0 0 20 20"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6.5h14M3 13.5h14" />}
            </svg>
          </button>
        </div>
      </div>

      {/* The sheet. A card under the pill rather than a full-bleed drawer, so
          the floating geometry holds all the way down. */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduced ? false : { opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? undefined : { opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto mx-auto mt-2 max-w-[62rem] origin-top overflow-hidden rounded-[1.75rem] border border-rule bg-paper/95 shadow-float backdrop-blur-xl lg:hidden"
          >
            <div className="flex flex-col p-5">
              <ul className="flex flex-col">
                {links.map((link, index) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      // A fragment click leaves the pathname alone, so the
                      // effect that closes this on navigation never fires.
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between gap-4 rounded-2xl px-3 py-3 font-display text-[1.25rem] font-bold tracking-[-0.02em] transition-colors hover:bg-ink/[0.045]"
                    >
                      {link.label}
                      <span className="tnum text-[0.75rem] font-sans font-medium text-ink-700">
                        0{index + 1}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>

              <span className="my-3 h-px bg-rule" />

              <Link
                to={other.to}
                className="rounded-2xl px-3 py-2.5 text-[0.9375rem] font-medium text-ink-700 transition-colors hover:bg-ink/[0.045]"
              >
                {other.label}
              </Link>

              <a
                href={WHATSAPP_URL}
                rel="noreferrer"
                className="mt-4 flex items-center justify-center gap-2.5 rounded-full bg-green px-5 py-3.5 text-[0.9375rem] font-semibold text-ink"
              >
                <WhatsAppGlyph />
                Chat on WhatsApp
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
