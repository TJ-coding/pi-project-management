/**
 * Form-based editing for the TUI.
 *
 * A `FormEditor` renders a list of typed fields (text, prose, int, float, enum,
 * list, refs) and lets the user move between them, cycle values, edit lists and
 * pick links to other entities. Long prose is delegated back to Pi's editor via
 * the `edit-prose` action, so the caller keeps a single modal-text path.
 *
 * The component only mutates the underlying draft through each field's
 * accessors; saving and validation stay in the command layer so the same
 * manager/history/Git path is used as for agent changes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FormFieldBase {
  key: string;
  label: string;
  /** Short hint shown dim on the right (may be computed from the draft). */
  hint?: string | (() => string);
}

export interface TextField extends FormFieldBase {
  kind: "text";
  get: () => string;
  set: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}

export interface ProseField extends FormFieldBase {
  kind: "prose";
  get: () => string;
  set: (value: string) => void;
  /** Number of preview lines. */
  lines?: number;
  required?: boolean;
}

export interface IntField extends FormFieldBase {
  kind: "int";
  get: () => number;
  set: (value: number) => void;
  min: number;
  max: number;
  /** Optional human label per value (e.g. 1 = low). */
  describe?: (value: number) => string;
}

export interface FloatField extends FormFieldBase {
  kind: "float";
  get: () => number;
  set: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Optional human label (e.g. exposure/band). */
  describe?: (value: number) => string;
}

export interface EnumField extends FormFieldBase {
  kind: "enum";
  get: () => string;
  set: (value: string) => void;
  options: readonly string[];
}

export interface ListField extends FormFieldBase {
  kind: "list";
  get: () => string[];
  set: (value: string[]) => void;
}

export interface RefsField extends FormFieldBase {
  kind: "refs";
  get: () => string[];
  set: (value: string[]) => void;
  /** Possible targets for the picker. */
  available: () => Array<{ id: string; label: string }>;
}

export interface RefField extends FormFieldBase {
  kind: "ref";
  get: () => string | null;
  set: (value: string | null) => void;
  available: () => Array<{ id: string; label: string }>;
}

export type FormField =
  | TextField
  | ProseField
  | IntField
  | FloatField
  | EnumField
  | ListField
  | RefsField
  | RefField;

export type FormAction =
  | { kind: "save" }
  | { kind: "cancel" }
  | { kind: "delete" }
  | { kind: "edit-prose"; key: string };

export interface FormEditorOptions {
  title: string;
  fields: FormField[];
  theme: Theme;
  /** Error to display (e.g. a rejected save). */
  error?: string;
  /** Info to display (e.g. a successful prose edit). */
  notice?: string;
  getTerminalRows?: () => number;
  onChange?: () => void;
  onExit: (action: FormAction) => void;
}

interface Row {
  field: FormField;
  /** -1 = the scalar row, >= 0 = list/refs item, -2 = the "+ add" row. */
  item: number;
}

interface EditState {
  row: number;
  buffer: string;
  cursor: number;
  /** Committed value when editing started, so Esc restores it. */
  original: string;
  /** For numeric fields: the first typed character replaces the prefilled value. */
  replaceOnType?: boolean;
}

interface PickerState {
  row: number;
  index: number;
}

const ADD_ROW = -2;

export class FormEditor {
  private fields: FormField[];
  private theme: Theme;
  private title: string;
  private error?: string;
  private notice?: string;
  private getTerminalRows?: () => number;
  private onChange?: () => void;
  private onExit: (action: FormAction) => void;
  private rows: Row[] = [];
  private active = 0;
  private edit: EditState | null = null;
  private picker: PickerState | null = null;
  private scroll = 0;

  constructor(options: FormEditorOptions) {
    this.title = options.title;
    this.fields = options.fields;
    this.theme = options.theme;
    this.error = options.error;
    this.notice = options.notice;
    this.getTerminalRows = options.getTerminalRows;
    this.onChange = options.onChange;
    this.onExit = options.onExit;
    this.buildRows();
  }

  /* ---------------- rows ---------------- */

  private buildRows(): void {
    const rows: Row[] = [];
    for (const field of this.fields) {
      if (field.kind === "list" || field.kind === "refs") {
        const count = field.get().length;
        for (let index = 0; index < count; index += 1) rows.push({ field, item: index });
        rows.push({ field, item: ADD_ROW });
      } else {
        rows.push({ field, item: -1 });
      }
    }
    this.rows = rows;
    this.active = Math.max(0, Math.min(this.active, rows.length - 1));
  }

  private currentRow(): Row | undefined {
    return this.rows[this.active];
  }

  private editValue(field: FormField): string {
    switch (field.kind) {
      case "text":
      case "prose":
        return field.get();
      case "int":
      case "float":
        return formatNumber(field.get());
      case "enum":
        return field.get();
      case "list":
      case "refs":
        return "";
      case "ref":
        return field.get() ?? "";
    }
  }

  /* ---------------- input ---------------- */

  handleInput(data: string): void {
    if (this.picker) {
      this.handlePickerInput(data);
      return;
    }
    if (this.edit) {
      this.handleEditInput(data);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.onExit({ kind: "cancel" });
      return;
    }
    if (matchesKey(data, "ctrl+s") || matchesKey(data, "s")) {
      const error = this.validate();
      if (error) {
        this.error = error;
        this.onChange?.();
        return;
      }
      this.onExit({ kind: "save" });
      return;
    }
    if (matchesKey(data, "shift+d")) {
      this.onExit({ kind: "delete" });
      return;
    }
    if (data === "d" || data === "x") {
      const rowForDelete = this.currentRow();
      if (rowForDelete && rowForDelete.field.kind === "list" && rowForDelete.item >= 0) {
        const items = [...rowForDelete.field.get()];
        items.splice(rowForDelete.item, 1);
        rowForDelete.field.set(items);
        this.buildRows();
        this.onChange?.();
      }
      return;
    }
    if (data === "a") {
      const rowForAdd = this.currentRow();
      if (rowForAdd && rowForAdd.field.kind === "list") {
        const items = [...rowForAdd.field.get(), ""];
        rowForAdd.field.set(items);
        this.buildRows();
        const index = this.rows.findIndex((row) => row.field === rowForAdd.field && row.item === items.length - 1);
        if (index >= 0) this.active = index;
        this.edit = { row: this.active, buffer: "", cursor: 0, original: "" };
        this.onChange?.();
      } else if (rowForAdd && (rowForAdd.field.kind === "refs" || rowForAdd.field.kind === "ref")) {
        this.picker = { row: this.active, index: 0 };
        this.onChange?.();
      }
      return;
    }
    if (matchesKey(data, "up")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.move(1);
      return;
    }
    const row = this.currentRow();
    if (!row) return;
    const { field, item } = row;

    if (matchesKey(data, "left")) {
      this.cycle(field, -1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.cycle(field, 1);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.activate(field, item);
      return;
    }
    // Vim-ish fallbacks for navigation when not editing.
    if (data === "k") {
      this.move(-1);
      return;
    }
    if (data === "j") {
      this.move(1);
      return;
    }
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.active = (this.active + delta + this.rows.length) % this.rows.length;
    this.edit = null;
    this.error = undefined;
    this.onChange?.();
  }

  /** Cycle enum/int/float values, or act on list rows. */
  private cycle(field: FormField, delta: number): void {
    switch (field.kind) {
      case "enum": {
        const options = field.options;
        const index = Math.max(0, options.indexOf(field.get()));
        field.set(options[(index + delta + options.length) % options.length]!);
        break;
      }
      case "int": {
        const next = clamp(field.get() + delta, field.min, field.max);
        field.set(Math.round(next));
        break;
      }
      case "float": {
        const step = field.step ?? 0.1;
        const next = clamp(field.get() + delta * step, field.min ?? 0, field.max ?? 1);
        field.set(Math.round(next * 1000) / 1000);
        break;
      }
      case "list":
      case "refs":
        return; // item-level editing via Enter/d
      case "text":
      case "prose": {
        // Left/Right inside a scalar just moves focus sideways; ignore.
        return;
      }
      case "ref":
        return;
    }
    this.onChange?.();
  }

  /** Enter on a row: start editing text/numbers, add list items, open pickers. */
  private activate(field: FormField, item: number): void {
    if (field.kind === "prose") {
      this.onExit({ kind: "edit-prose", key: field.key });
      return;
    }
    if (field.kind === "enum") {
      this.cycle(field, 1);
      return;
    }
    if (field.kind === "refs" || field.kind === "ref") {
      this.picker = { row: this.active, index: 0 };
      this.onChange?.();
      return;
    }
    if (field.kind === "list") {
      const items = [...field.get()];
      if (item === ADD_ROW) {
        items.push("");
        field.set(items);
        this.edit = { row: this.active, buffer: "", cursor: 0, original: "" };
        this.buildRows();
      } else {
        this.edit = { row: this.active, buffer: items[item] ?? "", cursor: (items[item] ?? "").length, original: items[item] ?? "" };
      }
      this.onChange?.();
      return;
    }
    // text / int / float
    const value = this.editValue(field);
    this.edit = {
      row: this.active,
      buffer: value,
      cursor: value.length,
      original: value,
      replaceOnType: field.kind === "int" || field.kind === "float",
    };
    this.onChange?.();
  }

  private handleEditInput(data: string): void {
    const edit = this.edit;
    if (!edit) return;
    if (matchesKey(data, "escape")) {
      this.edit = null;
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.commitEdit();
      return;
    }
    if (matchesKey(data, "backspace")) {
      edit.replaceOnType = false;
      if (edit.cursor > 0) {
        edit.buffer = edit.buffer.slice(0, edit.cursor - 1) + edit.buffer.slice(edit.cursor);
        edit.cursor -= 1;
      }
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "delete")) {
      edit.replaceOnType = false;
      edit.buffer = edit.buffer.slice(0, edit.cursor) + edit.buffer.slice(edit.cursor + 1);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "left")) {
      edit.replaceOnType = false;
      edit.cursor = Math.max(0, edit.cursor - 1);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "right")) {
      edit.replaceOnType = false;
      edit.cursor = Math.min(edit.buffer.length, edit.cursor + 1);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "home")) {
      edit.cursor = 0;
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "end")) {
      edit.cursor = edit.buffer.length;
      this.onChange?.();
      return;
    }
    // Printable input (ignore control sequences).
    if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
      if (edit.replaceOnType) {
        edit.buffer = data;
        edit.cursor = data.length;
        edit.replaceOnType = false;
      } else {
        edit.buffer = edit.buffer.slice(0, edit.cursor) + data + edit.buffer.slice(edit.cursor);
        edit.cursor += data.length;
      }
      this.onChange?.();
    }
  }

  private commitEdit(): void {
    const edit = this.edit;
    const row = this.rows[edit?.row ?? -1];
    if (!edit || !row) {
      this.edit = null;
      return;
    }
    const { field, item } = row;
    const value = edit.buffer;
    if (field.kind === "int") {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) field.set(Math.round(clamp(parsed, field.min, field.max)));
      else this.error = `${field.label} must be a number`;
    } else if (field.kind === "float") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) field.set(Math.round(clamp(parsed, field.min ?? 0, field.max ?? 1) * 1000) / 1000);
      else this.error = `${field.label} must be a number`;
    } else if (field.kind === "list") {
      const items = [...field.get()];
      if (item === ADD_ROW) {
        if (value.trim() !== "") items.push(value);
      } else if (value.trim() === "") {
        items.splice(item, 1); // committed blank item is discarded
      } else {
        items[item] = value;
      }
      field.set(items);
    } else if (field.kind === "text" || field.kind === "prose") {
      field.set(value);
    }
    this.edit = null;
    this.buildRows();
    this.onChange?.();
  }

  private handlePickerInput(data: string): void {
    const picker = this.picker;
    const row = this.rows[picker?.row ?? -1];
    if (!picker || !row) {
      this.picker = null;
      return;
    }
    const field = row.field;
    const candidates =
      field.kind === "refs" || field.kind === "ref" ? field.available() : [];
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.picker = null;
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      picker.index = Math.max(0, picker.index - 1);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      picker.index = Math.min(candidates.length - 1, picker.index + 1);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "enter")) {
      const candidate = candidates[picker.index];
      if (candidate) {
        if (field.kind === "refs") {
          const current = field.get();
          field.set(current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id]);
        } else if (field.kind === "ref") {
          field.set(field.get() === candidate.id ? null : candidate.id);
        }
      }
      this.picker = null;
      this.buildRows();
      this.onChange?.();
      return;
    }
  }

  /* ---------------- validation ---------------- */

  private validate(): string | null {
    for (const field of this.fields) {
      if ((field.kind === "text" || field.kind === "prose") && field.required && field.get().trim() === "") {
        return `${field.label} is required`;
      }
    }
    return null;
  }

  /* ---------------- rendering ---------------- */

  render(width: number): string[] {
    const theme = this.theme;
    const viewport = Math.max(4, Math.min(40, (this.getTerminalRows?.() ?? 24) - 6));
    const lines: string[] = [];
    for (const row of this.rows) lines.push(...this.renderRow(row, width));
    const total = lines.length;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - viewport)));
    this.ensureVisible(viewport);

    const out: string[] = [];
    out.push(truncateToWidth(theme.bg("customMessageBg", theme.fg("accent", theme.bold(` ${this.title} `))), width));

    const window = lines.slice(this.scroll, this.scroll + viewport);
    out.push(...window);
    for (let index = window.length; index < viewport; index += 1) out.push("");

    if (this.error) out.push(truncateToWidth(theme.fg("error", ` ✗ ${this.error}`), width));
    else if (this.notice) out.push(truncateToWidth(theme.fg("success", ` ✓ ${this.notice}`), width));
    else out.push("");

    const hint = this.picker
      ? "↑↓ choose · enter toggle link · esc close picker"
      : this.edit
        ? "type to edit · enter confirm · esc revert"
        : "↑↓ field · ←→ change · enter edit/pick · a add · d remove item · D delete · s save · esc cancel";
    out.push(truncateToWidth(theme.fg("dim", hint), width));
    out.push(truncateToWidth(theme.fg("dim", ` ${this.scroll + 1}-${Math.min(total, this.scroll + viewport)}/${total}`), width));
    return out.map((line) => truncateToWidth(line, width));
  }

  private ensureVisible(viewport: number): void {
    // Compute the line offset of the active row and scroll if needed.
    let offset = 0;
    for (let index = 0; index < this.rows.length; index += 1) {
      const height = this.rowHeight(this.rows[index]!);
      if (index === this.active) {
        if (offset < this.scroll) this.scroll = offset;
        else if (offset + height > this.scroll + viewport) this.scroll = offset + height - viewport;
        return;
      }
      offset += height;
    }
  }

  private rowHeight(row: Row): number {
    const { field, item } = row;
    if (field.kind === "list" || field.kind === "refs") return 1;
    if (field.kind === "prose") return 1 + Math.min(field.lines ?? 3, 3);
    return 1;
  }

  private renderRow(row: Row, width: number): string[] {
    const theme = this.theme;
    const { field, item } = row;
    const focused = this.rows[this.active] === row;
    const marker = focused ? theme.fg("accent", "▸ ") : "  ";
    const label = focused ? theme.fg("accent", theme.bold(field.label)) : theme.fg("muted", field.label);
    const labelWidth = 20;
    const prefix = marker + pad(label, labelWidth);

    if (this.picker && this.rows[this.picker.row] === row) {
      const candidates = field.kind === "refs" || field.kind === "ref" ? field.available() : [];
      const selected = field.kind === "refs" ? field.get() : field.get() ? [field.get() as string] : [];
      const lines = [truncateToWidth(`${prefix}${theme.fg("dim", "choose…")}`, width)];
      candidates.forEach((candidate, index) => {
        const isActive = index === this.picker!.index;
        const isSelected = selected.includes(candidate.id);
        const text = `${isSelected ? "●" : "○"} ${candidate.id} ${candidate.label}`;
        lines.push(
          truncateToWidth(
            `    ${isActive ? theme.fg("accent", theme.bold(text)) : theme.fg(isSelected ? "success" : "muted", text)}`,
            width,
          ),
        );
      });
      if (candidates.length === 0) lines.push(`    ${theme.fg("dim", "nothing to link to yet")}`);
      return lines;
    }

    if (field.kind === "list" || field.kind === "refs") {
      if (item === ADD_ROW) {
        return [truncateToWidth(`${prefix}${theme.fg("dim", "+ add")}`, width)];
      }
      const editing = this.edit && this.rows[this.edit.row] === row;
      const raw = field.kind === "list" ? field.get()[item] ?? "" : field.get()[item] ?? "";
      const value = editing ? renderEditor(this.edit!.buffer, this.edit!.cursor) : raw;
      const bullet = field.kind === "refs" ? "•" : "–";
      return [
        truncateToWidth(
          `    ${theme.fg("dim", `${bullet} `)}${editing ? theme.fg("text", value) : theme.fg("text", raw || theme.fg("dim", "(empty)"))}`,
          width,
        ),
      ];
    }

    const editing = this.edit && this.rows[this.edit.row] === row;
    let value = "";
    if (editing) {
      value = renderEditor(this.edit!.buffer, this.edit!.cursor);
    } else if (field.kind === "enum") {
      const current = field.get();
      value = field.options
        .map((option) => (option === current ? theme.fg("accent", theme.bold(`[${option}]`)) : theme.fg("dim", option)))
        .join(theme.fg("dim", " "));
    } else if (field.kind === "int" || field.kind === "float") {
      const numeric = field.get();
      const description = field.describe?.(numeric);
      value =
        theme.fg("text", formatNumber(numeric)) +
        (description ? theme.fg("dim", `  ${description}`) : "");
    } else if (field.kind === "ref") {
      const current = field.get();
      value = current ? theme.fg("text", current) : theme.fg("dim", "none");
    } else if (field.kind === "prose") {
      const text = field.get();
      const preview = text ? text.split("\n").slice(0, 3).join("\n") : theme.fg("dim", "(empty)");
      const lines = [truncateToWidth(`${prefix}${theme.fg("text", preview.split("\n")[0] ?? "")}${focused ? theme.fg("dim", "  …enter to edit") : ""}`, width)];
      for (const extra of preview.split("\n").slice(1)) lines.push(truncateToWidth(`    ${theme.fg("muted", extra)}`, width));
      return lines;
    } else {
      const text = field.get();
      value = text ? theme.fg("text", text) : theme.fg("dim", field.placeholder ?? "(empty)");
    }

    const hintText = typeof field.hint === "function" ? field.hint() : field.hint;
    const hint = hintText && !focused ? theme.fg("dim", `  ${hintText}`) : "";
    return [truncateToWidth(`${prefix}${value}${hint}`, width)];
  }

  invalidate(): void {
    /* rendering is computed fresh each time */
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible === width) return text;
  if (visible > width) return truncateToWidth(text, width);
  return text + " ".repeat(width - visible);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Render an editing buffer with a block cursor. */
function renderEditor(buffer: string, cursor: number): string {
  const before = buffer.slice(0, cursor);
  const at = buffer.slice(cursor, cursor + 1) || " ";
  const after = buffer.slice(cursor + 1);
  return `${before}\x1b[7m${at}\x1b[27m${after}`;
}
