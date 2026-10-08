import Lenis from "lenis";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Smooth scroll for the whole document, plus in-page anchor handling.
 *
 * Tuned long and soft rather than snappy: the wheel is damped slightly below
 * 1:1 so a flick glides instead of jumping, and the easing is a single
 * exponential ease-out so motion decays rather than stopping. Touch is left
 * alone — native momentum on a phone is better than anything we would
 * reimplement, and fighting it is what makes a site feel broken on mobile.
 *
 * Skipped entirely under prefers-reduced-motion: hijacking the scroll is
 * exactly what that setting is asking us not to do.
 */
export function useLenis(): void {
  const reduced = useReducedMotion();
  const { pathname, hash } = useLocation();
  const lenis = useRef<Lenis | null>(null);

  useEffect(() => {
    if (reduced) return;

    const instance = new Lenis({
      duration: 1.35,
      easing: (t: number) => 1 - Math.pow(1 - t, 3.2),
      smoothWheel: true,
      wheelMultiplier: 0.92,
      syncTouch: false,
      touchMultiplier: 1.5,
    });
    lenis.current = instance;

    let frame = 0;
    const raf = (time: number) => {
      instance.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    const onAnchorClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as HTMLElement | null)?.closest(
        "a[href]"
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;

      // The nav and footer write these as "/#how" rather than "#how" so one
      // list of links works from every page. Resolve the href and only take
      // over when it lands on a fragment of the page we are already on —
      // anything else is a real navigation and belongs to the browser.
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname !== window.location.pathname) return;

      const id = decodeURIComponent(url.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;

      event.preventDefault();
      // Keep the address bar honest without going through the router, whose
      // location change would re-run the effect below and restart the scroll
      // we are in the middle of.
      window.history.replaceState(window.history.state, "", url.hash);
      // No offset here. Lenis reads the target's own scroll-margin-top, which
      // every section already sets for the native jump — passing a clearance
      // as well lands a section-height too high.
      instance.scrollTo(target, { duration: 1.1 });
    };

    document.addEventListener("click", onAnchorClick);

    return () => {
      document.removeEventListener("click", onAnchorClick);
      cancelAnimationFrame(frame);
      instance.destroy();
      lenis.current = null;
    };
  }, [reduced]);

  // Route changes start at the top; a hash on the URL wins over that. This
  // only fires for arrivals — a hash typed in, followed from elsewhere, or
  // reached by a link that crossed pages. Same-page clicks are handled above.
  useEffect(() => {
    const instance = lenis.current;
    const target = hash ? document.getElementById(hash.slice(1)) : null;

    if (!target) {
      if (instance) instance.scrollTo(0, { immediate: true });
      else window.scrollTo(0, 0);
      return;
    }

    if (instance) {
      instance.scrollTo(target, { duration: 1.1 });
    } else {
      target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  }, [pathname, hash, reduced]);
}
