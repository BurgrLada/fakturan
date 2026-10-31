"use client";

import { useRef, useState, type FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import { VARIABLE_NAMES } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.recurring.variables;

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTextField(target: EventTarget): target is TextField {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type === "text")
  );
}

// The setter and the input event go through React's own tracking, so the controlled field updates.
function insertAt(field: TextField, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(prototype.prototype, "value")!.set!;
  setValue.call(field, field.value.slice(0, start) + text + field.value.slice(end));
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useVariableTarget() {
  const last = useRef<TextField | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return {
    message,
    // Put on the container whose text fields accept variables.
    onFocusCapture(event: FocusEvent) {
      if (isTextField(event.target)) last.current = event.target;
    },
    insert(name: string) {
      const field = last.current;
      if (!field?.isConnected) {
        setMessage(T.noField);
        return;
      }
      insertAt(field, `{{${name}}}`);
      setMessage(null);
    },
  };
}

export function VariablePicker({
  onInsert,
  message,
}: {
  onInsert: (name: string) => void;
  message: string | null;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="variable-picker">
      <h3 className="text-sm font-medium">{T.title}</h3>
      <p className="text-sm text-muted-foreground">{T.hint}</p>
      <ul className="flex flex-wrap gap-2">
        {VARIABLE_NAMES.map((name) => (
          <li key={name}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={T.insert(name)}
              title={T.labels[name]}
              onClick={() => onInsert(name)}
            >
              {`{{${name}}}`}
            </Button>
          </li>
        ))}
      </ul>
      <p role="status" className="min-h-4 text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
