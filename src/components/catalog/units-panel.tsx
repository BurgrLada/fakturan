"use client";

import { useState, useTransition, type FormEvent } from "react";
import { deleteUnitAction, saveUnitAction } from "@/app/(app)/cenik/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.catalog.units;

export function UnitsPanel({ units }: { units: { id: string | null; name: string }[] }) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveUnitAction({ name });
      if (result.ok) setName("");
      setMessage({ ok: result.ok, text: result.ok ? T.added : result.error });
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await deleteUnitAction({ id });
      setMessage(result.ok ? null : { ok: false, text: result.error });
    });
  }

  return (
    <section className="flex flex-col gap-3 sm:max-w-xl">
      <h2 className="text-lg">{T.title}</h2>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <ul className="flex flex-wrap gap-2">
        {units.map((unit) => (
          <li
            key={unit.name}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
          >
            {unit.name}
            {unit.id && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={T.removeLabel(unit.name)}
                onClick={() => remove(unit.id as string)}
              >
                ×
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="unit-name">{T.name}</Label>
          <Input
            id="unit-name"
            value={name}
            maxLength={20}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {T.add}
        </Button>
      </form>
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
