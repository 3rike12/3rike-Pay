/**
 * Which way the home hero carries its photograph.
 *
 * "photo" — the picture is the hero. A dark scrim over it, type reversed to
 *   paper. This is the Blink treatment: the image reads first, the words sit
 *   on top of it.
 * "veil"  — the hero stays as it was, light and papery, with the picture set
 *   behind a whitish veil so it reads as ground rather than subject.
 *
 * Both are built. Flip this one line to switch, and once the choice is settled
 * the losing branch comes out.
 */
export type HeroTreatment = "photo" | "veil";

export const HERO_TREATMENT: HeroTreatment = "photo";

/** Credit for the hero photograph, per Unsplash's guidance. */
export const HERO_PHOTO = {
  src: "/hero-lagos-1920.webp",
  srcSmall: "/hero-lagos-1200.webp",
  alt: "",
  photographer: "Oluwafemi Deyon",
  href: "https://unsplash.com/photos/young-man-in-maroon-shirt-and-jeans-sits-outdoors-t0gftI3s2QY",
} as const;
