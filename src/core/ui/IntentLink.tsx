"use client";

import { useState, type ComponentProps } from "react";
import Link from "next/link";

/**
 * A Link that fetches the WHOLE destination page while the pointer is on it
 * (or it has keyboard focus), so the click lands on data that is already here.
 *
 * Module pages are dynamic, so a plain Link only prefetches down to the route's
 * loading boundary. Prefetching every link in full on page load would render
 * every page on the server for nothing; the ~150–300 ms between hover and
 * click is enough for most pages. Intent drops on leave, so an invalidation
 * (every save calls revalidatePath) doesn't re-prefetch links nobody is near.
 */
export function IntentLink({ onMouseEnter, onMouseLeave, onFocus, onBlur, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? true : null}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setIntent(false);
        onMouseLeave?.(e);
      }}
      onFocus={(e) => {
        setIntent(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setIntent(false);
        onBlur?.(e);
      }}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
    />
  );
}
