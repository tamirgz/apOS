"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { markAllNotificationsRead } from "@/core/ui/notifications-actions";

export function MarkAllReadButton() {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markAllNotificationsRead();
          router.refresh();
        })
      }
      className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:border-plasma/30 disabled:opacity-40"
    >
      <CheckCheck className="size-3" />
      {pending ? "…" : "mark all read"}
    </button>
  );
}
