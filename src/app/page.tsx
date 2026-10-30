import { Suspense } from "react";
import { SessionBar } from "@/components/auth/session-bar";
import { Logo } from "@/components/logo";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <Logo className="w-64" />
      <p className="font-brand text-muted-foreground">Jednoduchá fakturace pro české OSVČ</p>
      <Suspense>
        <SessionBar />
      </Suspense>
    </main>
  );
}
