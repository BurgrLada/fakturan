"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{TEXTS.error.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        {TEXTS.error.body}
        <Button type="button" variant="outline" onClick={reset}>
          {TEXTS.error.retry}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
