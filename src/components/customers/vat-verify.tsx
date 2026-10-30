"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { verifyVatAction } from "@/app/(app)/zakaznici/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.customers.vat;

type State = "valid" | "invalid" | "unavailable";

export function VatVerify({ id, hasVatId }: { id: string; hasVatId: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function verify() {
    startTransition(async () => {
      const response = await verifyVatAction({ id });
      if (!response.ok) {
        setResult({ ok: false, text: response.error });
        return;
      }
      const state: State = response.status.state;
      setResult({ ok: state === "valid", text: T[state] });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="outline" disabled={pending || !hasVatId} onClick={verify}>
          {pending ? T.verifying : T.verify}
        </Button>
      </div>
      {result && (
        <Alert variant={result.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
