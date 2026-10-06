import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * A single, restrained reveal. Used only where content genuinely *arrives* —
 * chat threads and the invoice walkthrough — not on every section, which is
 * what makes a page feel machine-made.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** Render as `li` inside a list, so the wrapper doesn't break its semantics. */
  as?: "div" | "li";
}) {
  const reduced = useReducedMotion();
  const Tag = as === "li" ? "li" : "div";
  const Motion = as === "li" ? motion.li : motion.div;

  if (reduced) return <Tag className={className}>{children}</Tag>;

  return (
    <Motion
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-12% 0px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Motion>
  );
}
