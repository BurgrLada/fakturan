"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { saveLineToCatalogAction } from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Currency } from "@/lib/currency";
import { blankLine, isEmptyLine, type FormLine } from "@/lib/invoice-form";
import { DISCOUNT_KINDS, type DiscountKind } from "@/lib/invoice-totals";
import { formatMoney, formatMoneyInput, parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { CatalogPicker, type CatalogChoice } from "./catalog-picker";

const T = TEXTS.invoices.form;
const L = T.line;

function LineRow({
  line,
  position,
  currency,
  net,
  units,
  invalid,
  onChange,
  onRemove,
  onlyLine,
}: {
  line: FormLine;
  position: number;
  currency: Currency;
  net: number | null;
  units: string;
  invalid: ReadonlySet<string>;
  onChange: (patch: Partial<FormLine>) => void;
  onRemove: () => void;
  onlyLine: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: line.key });
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const id = (field: string) => `line-${line.key}-${field}`;
  const isInvalid = (field: string) => invalid.has(id(field)) || undefined;

  function pick(item: CatalogChoice) {
    onChange({
      catalogItemId: item.id,
      name: item.name,
      description: item.description,
      unit: item.unit,
      price: formatMoneyInput(item.priceMinor),
      priceCurrency: item.currency,
    });
  }

  async function toCatalog() {
    setCatalogError(null);
    try {
      const result = await saveLineToCatalogAction({
        name: line.name,
        description: line.description,
        unit: line.unit,
        priceMinor: parseMoney(line.price || "0") ?? 0,
        currency,
      });
      if (result.ok) onChange({ catalogItemId: result.id, priceCurrency: currency });
      else setCatalogError(result.error);
    } catch {
      setCatalogError(T.network);
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="invoice-line"
      className={`flex gap-2 rounded-md border bg-card p-3 ${isDragging ? "relative z-10 shadow-md" : ""}`}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="cursor-grab touch-none"
        aria-label={L.move(position)}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-6">
            <Label htmlFor={id("name")}>{L.name}</Label>
            <CatalogPicker
              id={id("name")}
              value={line.name}
              onChange={(name) => onChange({ name })}
              onPick={pick}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <Label htmlFor={id("quantity")}>{L.quantity}</Label>
            <Input
              id={id("quantity")}
              inputMode="decimal"
              aria-invalid={isInvalid("quantity")}
              value={line.quantity}
              onChange={(event) => onChange({ quantity: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <Label htmlFor={id("unit")}>{L.unit}</Label>
            <Input
              id={id("unit")}
              list={units}
              maxLength={20}
              value={line.unit}
              onChange={(event) => onChange({ unit: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <Label htmlFor={id("price")}>{L.price}</Label>
            <Input
              id={id("price")}
              inputMode="decimal"
              aria-invalid={isInvalid("price")}
              value={line.price}
              onChange={(event) => onChange({ price: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <Label htmlFor={id("discountKind")}>{L.discountKind}</Label>
            <NativeSelect
              id={id("discountKind")}
              value={line.discountKind}
              onChange={(event) => onChange({ discountKind: event.target.value as DiscountKind })}
            >
              {DISCOUNT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {T.discounts[kind]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {line.discountKind !== "none" && (
            <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
              <Label htmlFor={id("discount")}>{L.discountValue}</Label>
              <Input
                id={id("discount")}
                inputMode="decimal"
                aria-invalid={isInvalid("discount")}
                value={line.discount}
                onChange={(event) => onChange({ discount: event.target.value })}
              />
            </div>
          )}
          {net !== null && (
            <p className="flex items-end justify-end gap-2 text-sm sm:col-span-2 sm:col-start-5">
              <span className="text-muted-foreground">{L.net}</span>
              <span data-testid="line-net">{formatMoney(net, currency)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id("description")}>{L.description}</Label>
          <Textarea
            id={id("description")}
            value={line.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </div>
        {line.priceCurrency && line.priceCurrency !== currency && (
          <Alert role="status">
            <AlertDescription>{L.currencyWarning(line.priceCurrency, currency)}</AlertDescription>
          </Alert>
        )}
        {catalogError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{catalogError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {line.catalogItemId ? (
            <span className="text-xs text-muted-foreground">{L.inCatalog}</span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!line.name.trim()}
              onClick={toCatalog}
            >
              {L.toCatalog}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            disabled={onlyLine && isEmptyLine(line)}
            aria-label={L.remove(position)}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function LineEditor({
  lines,
  currency,
  nets,
  units,
  defaultUnit,
  invalid,
  onChange,
}: {
  lines: FormLine[];
  currency: Currency;
  nets: ReadonlyMap<string, number>;
  units: string[];
  defaultUnit: string;
  invalid: ReadonlySet<string>;
  onChange: (lines: FormLine[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const positionOf = (key: unknown) => lines.findIndex((line) => line.key === key) + 1;

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(lines, positionOf(active.id) - 1, positionOf(over.id) - 1));
  }

  function patch(key: string, change: Partial<FormLine>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));
  }

  function remove(key: string) {
    const rest = lines.filter((line) => line.key !== key);
    onChange(rest.length > 0 ? rest : [blankLine(defaultUnit)]);
  }

  return (
    <div id="field-lines" tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <datalist id="line-units">
        {units.map((unit) => (
          <option key={unit} value={unit} />
        ))}
      </datalist>
      <DndContext
        id="invoice-lines"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          screenReaderInstructions: { draggable: T.dragInstructions },
          announcements: {
            onDragStart: ({ active }) => T.dragPicked(positionOf(active.id)),
            onDragOver: ({ over }) => (over ? T.dragOver(positionOf(over.id)) : undefined),
            onDragEnd: ({ over }) => (over ? T.dragDropped(positionOf(over.id)) : T.dragCancelled),
            onDragCancel: () => T.dragCancelled,
          },
        }}
      >
        <SortableContext
          items={lines.map((line) => line.key)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-3">
            {lines.map((line, index) => (
              <LineRow
                key={line.key}
                line={line}
                position={index + 1}
                currency={currency}
                net={nets.get(line.key) ?? null}
                units="line-units"
                invalid={invalid}
                onlyLine={lines.length === 1}
                onChange={(change) => patch(line.key, change)}
                onRemove={() => remove(line.key)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...lines, blankLine(defaultUnit)])}
        >
          <Plus aria-hidden /> {L.add}
        </Button>
      </div>
    </div>
  );
}
