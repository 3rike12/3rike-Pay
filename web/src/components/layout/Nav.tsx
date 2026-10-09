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
  { label: "Docs", href: "/doc" },
];

const BUSINESS_LINKS = [
  { label: "Getting paid", href: "/business#flow" },
  { label: "Fees", href: "/business#fees" },
  { label: "Questions", href: "/business#faq" },
  { label: "Docs", href: "/doc" },
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
 *
 * The bar also says which half of the product you are in, because the two
 * halves are genuinely different services — naira transfers on one side,
 * franc collections on the other — and a reader who cannot tell them apart
 * reads the wrong fees. Personal and business are a real switch rather than
 * a "go here instead" link, business carries the logo's olive and lime
 * against personal's green, and the docs carry neither.
 */

type Mode = "personal" | "business" | "docs";

export function Nav() {
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  const mode: Mode = pathname.startsWith("/business")
    ? "business"
    : pathname.startsWith("/doc")
      ? "docs"
      : "personal";

  const solid = scrolled || open;
  // The only page whose first screen is dark. Everywhere else the bare bar
  // sits on paper and the type stays as it is.
  const onDark = !solid && pathname === "/";
  const links = mode === "business" ? BUSINESS_LINKS : HOME_LINKS;

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

  /** A plain path routes; a fragment stays an anchor so Lenis can take it. */
  const linkClass = cn(
    "whitespace-nowrap rounded-full px-2.5 py-2 text-[0.875rem] font-medium transition-colors duration-200",
    onDark ? "text-paper hover:bg-paper/15" : "text-ink-700 hover:bg-ink/[0.055] hover:text-ink"
  );

  const toggle = (
    <div
      className={cn(
        "hidden shrink-0 items-center gap-0.5 rounded-full border p-[0.1875rem] transition-colors duration-[600ms] ease-brand md:inline-flex",
        onDark ? "border-paper/25 bg-paper/10" : "border-rule bg-ink/[0.045]"
      )}
    >
      {([
        { label: "Personal", to: "/", key: "personal" },
        { label: "Business", to: "/business", key: "business" },
      ] as const).map((item) => {
        const active = mode === item.key;
        return (
          <Link
            key={item.key}
            to={item.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-full px-3 py-[0.4375rem] text-[0.8125rem] transition-colors duration-200",
              active && item.key === "personal" && "bg-ink font-semibold text-paper",
              // The logo's own lime. Dark type on a pale fill, so the business
              // side reads as a different place without a second brand colour
              // competing with the green call to action beside it.
              active && item.key === "business" &&
                "bg-lime font-semibold text-green-ink ring-1 ring-olive/30",
              !active && (onDark
                ? "font-medium text-paper hover:bg-paper/15"
                : "font-medium text-ink-700 hover:bg-ink/[0.06] hover:text-ink")
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={cn(
          "pointer-events-auto mx-auto flex items-center justify-between gap-5 rounded-full px-4 transition-all duration-[600ms] ease-brand sm:px-5",
          solid
            ? "h-[3.5rem] max-w-[68rem] shadow-float backdrop-blur-xl"
            : "h-[4.25rem] max-w-[78rem] border border-transparent bg-transparent",
          // Business glass is tinted. It is the one change you cannot miss on
          // a page you landed on from a search.
          // /85, not /70: measured against the dark band this bar crosses,
          // where a thinner tint puts the links at 3.69:1.
          solid && mode === "business" && "border border-olive/25 bg-lime-pale/85",
          solid && mode !== "business" && "border border-rule bg-paper/80"
        )}
      >
        <Wordmark tone={onDark ? "dark" : "light"} />

        <ul className="hidden shrink-0 items-center gap-0.5 lg:flex">
          {links.map((link) => {
            const routed = !link.href.includes("#");
            const current = routed && pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                {routed ? (
                  <Link
                    to={link.href}
                    aria-current={current ? "page" : undefined}
                    className={cn(linkClass, current && "bg-ink font-semibold text-paper")}
                  >
                    {link.label}
                  </Link>
                ) : (
                  <a href={link.href} className={linkClass}>
                    {link.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {toggle}

          <a
            href={WHATSAPP_URL}
            rel="noreferrer"
            className="hidden items-center gap-2 rounded-full bg-green px-4 py-2.5 text-[0.875rem] font-semibold text-ink shadow-[0_6px_16px_-8px_rgba(1,194,89,0.8)] transition-all duration-300 ease-brand hover:bg-green-hover active:scale-[0.98] sm:inline-flex"
          >
            <WhatsAppGlyph className="size-4" />
            <span className="hidden whitespace-nowrap xl:inline">Chat on WhatsApp</span>
            <span className="xl:hidden">Chat</span>
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
            className={cn(
              "pointer-events-auto mx-auto mt-2 max-w-[68rem] origin-top overflow-hidden rounded-[1.75rem] border shadow-float backdrop-blur-xl lg:hidden",
              mode === "business" ? "border-olive/25 bg-lime-pale/95" : "border-rule bg-paper/95"
            )}
          >
            <div className="flex flex-col p-5">
              <ul className="flex flex-col">
                {links.map((link, index) => {
                  const routed = !link.href.includes("#");
                  const rowClass =
                    "flex items-center justify-between gap-4 rounded-2xl px-3 py-3 font-display text-[1.25rem] font-bold tracking-[-0.02em] transition-colors hover:bg-ink/[0.045]";
                  const number = (
                    <span className="tnum font-sans text-[0.75rem] font-medium text-ink-700">
                      0{index + 1}
                    </span>
                  );
                  return (
                    <li key={link.href}>
                      {routed ? (
                        <Link to={link.href} className={rowClass}>
                          {link.label}
                          {number}
                        </Link>
                      ) : (
                        <a
                          href={link.href}
                          // A fragment click leaves the pathname alone, so the
                          // effect that closes this on navigation never fires.
                          onClick={() => setOpen(false)}
                          className={rowClass}
                        >
                          {link.label}
                          {number}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>

              <span className="my-3 h-px bg-rule" />

              {/* The same switch, laid out as two halves of a row — a sheet
                  has the width for both labels to sit side by side. */}
              <div className="grid grid-cols-2 gap-2">
                {([
                  { label: "Personal", to: "/", key: "personal" },
                  { label: "Business", to: "/business", key: "business" },
                ] as const).map((item) => {
                  const active = mode === item.key;
                  return (
                    <Link
                      key={item.key}
                      to={item.to}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "rounded-2xl border px-3 py-2.5 text-center text-[0.9375rem] transition-colors",
                        active && item.key === "personal" &&
                          "border-ink bg-ink font-semibold text-paper",
                        active && item.key === "business" &&
                          "border-olive/40 bg-lime font-semibold text-green-ink",
                        !active && "border-rule font-medium text-ink-700 hover:bg-ink/[0.045]"
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>

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
