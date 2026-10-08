import { useEffect, useState } from "react";

/**
 * Matches a media query, re-evaluating when it changes.
 *
 * Used for art direction rather than layout — Tailwind handles layout. The
 * hero needs a genuinely shorter conversation on a phone, and that is a choice
 * about content, not about CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
