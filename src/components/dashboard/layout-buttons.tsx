"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDownUp,
  ChevronsLeftRight,
  ChevronsRightLeft,
  ChevronsUpDown,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Direction } from "@/lib/dashboard-layout";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.dashboard.edit;

export type LayoutStep =
  | { kind: "move"; direction: Direction }
  | { kind: "resize"; dw: number; dh: number };

const STEPS: { step: LayoutStep; label: string; icon: LucideIcon }[] = [
  { step: { kind: "move", direction: "left" }, label: T.move.left, icon: ArrowLeft },
  { step: { kind: "move", direction: "up" }, label: T.move.up, icon: ArrowUp },
  { step: { kind: "move", direction: "down" }, label: T.move.down, icon: ArrowDown },
  { step: { kind: "move", direction: "right" }, label: T.move.right, icon: ArrowRight },
  { step: { kind: "resize", dw: -1, dh: 0 }, label: T.resize.narrower, icon: ChevronsRightLeft },
  { step: { kind: "resize", dw: 1, dh: 0 }, label: T.resize.wider, icon: ChevronsLeftRight },
  { step: { kind: "resize", dw: 0, dh: -1 }, label: T.resize.shorter, icon: ChevronsDownUp },
  { step: { kind: "resize", dw: 0, dh: 1 }, label: T.resize.taller, icon: ChevronsUpDown },
];

// UI-008, R-2: the full keyboard alternative to dragging, never disabled, so focus stays on the
// button pressed and an impossible step is announced instead.
export function LayoutButtons({
  title,
  onStep,
}: {
  title: string;
  onStep: (step: LayoutStep) => void;
}) {
  return (
    <div role="group" aria-label={T.layout(title)} className="flex flex-wrap gap-1">
      {STEPS.map(({ step, label, icon: Icon }) => (
        <Button
          key={label}
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={T.action(label, title)}
          title={label}
          onClick={() => onStep(step)}
        >
          <Icon aria-hidden />
        </Button>
      ))}
    </div>
  );
}
