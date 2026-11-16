import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DeviceOutputEntry } from "@t3tools/tessaya-contracts";
import { OUTPUT_STATE_LINE, moveOutput, outputLabel } from "@t3tools/tessaya-shared/deviceView";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/** A Tessel's outputs, first choice first. Keyboard users reorder with the step buttons. */
export function OutputOrderList(props: {
  readonly outputs: ReadonlyArray<DeviceOutputEntry>;
  readonly disabled: boolean;
  readonly onOrder: (order: ReadonlyArray<string>) => void;
}) {
  const { outputs, disabled, onOrder } = props;
  const ids = outputs.map((o) => o.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const move = (id: string, steps: number) => onOrder(moveOutput(outputs, id, steps));
  const handleDragEnd = (event: DragEndEvent) => {
    if (disabled || event.over === null || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1) move(String(event.active.id), to - from);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol
          aria-label="Outputs, first choice first"
          className="divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {outputs.map((o, index) => (
            <OutputRow
              key={o.id}
              output={o}
              position={index + 1}
              count={outputs.length}
              disabled={disabled}
              onMove={(steps) => move(o.id, steps)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function OutputRow(props: {
  readonly output: DeviceOutputEntry;
  readonly position: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onMove: (steps: number) => void;
}) {
  const name = outputLabel(props.output);
  const { state } = props.output;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.output.id, disabled: props.disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 ps-3 pe-1.5 @min-[32rem]/settings-row:grid-cols-[1rem_auto_minmax(0,1fr)_auto_auto]",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <span className="text-xs tabular-nums text-muted-foreground">{props.position}</span>
      <span className="col-span-2 text-sm leading-5 break-words @min-[32rem]/settings-row:col-span-1">
        {name}
      </span>
      <span className="col-start-2 flex @min-[32rem]/settings-row:col-start-auto">
        {state === "playing" ? (
          <span className="rounded-sm bg-success/12 px-1 text-2xs text-success-foreground">
            {OUTPUT_STATE_LINE.playing}
          </span>
        ) : (
          <span className="text-2xs text-muted-foreground">{OUTPUT_STATE_LINE[state]}</span>
        )}
      </span>
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        className="hidden size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing @min-[32rem]/settings-row:flex"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <span className="flex items-center gap-0.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === 1}
          aria-label={`Move ${name} up`}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === props.count}
          aria-label={`Move ${name} down`}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
      </span>
    </li>
  );
}
