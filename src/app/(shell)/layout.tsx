import { AnimatedBg } from "@/core/ui/AnimatedBg";
import { CommandBar } from "@/core/ui/CommandBar";
import { MotionProvider } from "@/core/ui/MotionProvider";
import { Sidebar } from "@/core/ui/Sidebar";
import { Toasts } from "@/core/ui/Toasts";
import { TopBar } from "@/core/ui/TopBar";

export default function ShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <MotionProvider>
      <div className="flex min-h-screen">
        <AnimatedBg />
        <CommandBar />
        <Toasts />
        <Sidebar />
        <main className="min-w-0 flex-1 p-3 pl-5 max-md:pl-14">
          <div className="mx-auto max-w-7xl">
            <TopBar />
            {children}
          </div>
        </main>
      </div>
    </MotionProvider>
  );
}
