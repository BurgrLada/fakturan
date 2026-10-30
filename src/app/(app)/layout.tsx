import { SessionKeepAlive } from "@/components/auth/session-controls";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-4">
      {children}
      <SessionKeepAlive />
    </main>
  );
}
