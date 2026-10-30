"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { foldText } from "@/lib/fold-text";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.form;

export function TagInput({
  tags,
  options,
  onChange,
}: {
  tags: string[];
  options: string[];
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState("");

  function add() {
    const name = text.trim();
    setText("");
    if (!name || tags.some((tag) => foldText(tag) === foldText(name))) return;
    onChange([...tags, name]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && !text && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="field-tags">{T.tagAdd}</Label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <li key={tag} className="flex items-center gap-1 rounded-sm bg-muted pl-2 text-xs">
              {tag}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={T.tagRemove(tag)}
                onClick={() => onChange(tags.filter((other) => other !== tag))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id="field-tags"
        list="field-tags-options"
        autoComplete="off"
        aria-describedby="field-tags-hint"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
      <datalist id="field-tags-options">
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <p id="field-tags-hint" className="text-xs text-muted-foreground">
        {T.tagHint}
      </p>
    </div>
  );
}
