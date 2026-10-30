import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4">
      <Logo className="w-40" />
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
