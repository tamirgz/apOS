"use client";

import { MotionConfig } from "motion/react";

/**
 * App-wide motion policy. `reducedMotion="user"` makes EVERY `motion.*` component
 * honor the OS `prefers-reduced-motion: reduce` setting automatically (framer
 * disables transform/layout animation, keeps opacity) — without it, our ~28
 * motion components animate regardless of the preference, unlike our CSS
 * animations which already respect the media query.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
