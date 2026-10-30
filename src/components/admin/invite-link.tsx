"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function InviteLink({ url, mailSent }: { url: string; mailSent: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {mailSent
          ? "Pozvánka odešla e-mailem. Odkaz můžete předat i sami:"
          : "E-mail se neodeslal, předejte tento odkaz pozvanému sami:"}
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Odkaz pozvánky" />
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? "Zkopírováno" : "Kopírovat"}
        </Button>
      </div>
    </div>
  );
}
