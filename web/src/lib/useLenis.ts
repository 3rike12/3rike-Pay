import Lenis from "lenis";
import { useEffect } from "react";
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

  useEffect(() => {
    if (reduced) return;

    const lenis = new Lenis({
      duration: 1.35,
      easing: (t: number) => 1 - Math.pow(1 - t, 3.2),
      smoothWheel: true,
      wheelMultiplier: 0.92,
      syncTouch: false,
      touchMultiplier: 1.5,
    });

    let frame = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    const onAnchorClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) {
        return;
      }
      const anchor = (event.target as HTMLElement | null)?.closest(
        'a[href^="#"]'
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const id = anchor.getAttribute("href")?.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: -96, duration: 1.1 });
    };

    document.addEventListener("click", onAnchorClick);

    return () => {
      document.removeEventListener("click", onAnchorClick);
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [reduced]);

  // Route changes start at the top; a hash on the URL wins over that.
  useEffect(() => {
    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash, reduced]);
}
