"use client";

import { motion } from "motion/react";

/** Re-mounts on every navigation → a quick fade per page. Kept short and
 *  opacity-only: this is a tool opened dozens of times a day, and a long
 *  blur/rise made every page feel slow. */
export default function ShellTemplate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
