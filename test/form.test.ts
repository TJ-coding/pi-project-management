import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FormEditor, formatNumber, type FormAction, type FormField } from "../src/form.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

interface Draft {
  title: string;
  priority: number;
  probability: number;
  status: string;
  criteria: string[];
  links: string[];
  parent: string | null;
  vision: string;
}

function makeDraft(): Draft {
  return { title: "Original", priority: 3, probability: 0.5, status: "ACTIVE", criteria: [], links: ["G1"], parent: null, vision: "Original vision" };
}

function makeEditor(draft: Draft, actions: FormAction[] = []): FormEditor {
  const fields: FormField[] = [
    { kind: "text", key: "title", label: "Title", required: true, get: () => draft.title, set: (v) => (draft.title = v) },
    { kind: "int", key: "priority", label: "Priority", min: 1, max: 5, get: () => draft.priority, set: (v) => (draft.priority = v) },
    { kind: "float", key: "probability", label: "Probability", min: 0, max: 1, step: 0.05, get: () => draft.probability, set: (v) => (draft.probability = v) },
    { kind: "enum", key: "status", label: "Status", options: ["ACTIVE", "COMPLETED", "FAILED"], get: () => draft.status, set: (v) => (draft.status = v) },
    { kind: "prose", key: "vision", label: "Vision", get: () => draft.vision, set: (v) => (draft.vision = v) },
    { kind: "list", key: "criteria", label: "Criteria", get: () => draft.criteria, set: (v) => (draft.criteria = v) },
    {
      kind: "refs",
      key: "links",
      label: "Links",
      get: () => draft.links,
      set: (v) => (draft.links = v),
      available: () => [
        { id: "G1", label: "Goal one" },
        { id: "G2", label: "Goal two" },
      ],
    },
    {
      kind: "ref",
      key: "parent",
      label: "Parent",
      get: () => draft.parent,
      set: (v) => (draft.parent = v),
      available: () => [{ id: "G1", label: "Goal one" }, { id: "G2", label: "Goal two" }],
    },
  ];
  return new FormEditor({
    title: "Test form",
    fields,
    theme,
    getTerminalRows: () => 30,
    onExit: (action) => actions.push(action),
  });
}

const down = (editor: FormEditor, times = 1): void => {
  for (let index = 0; index < times; index += 1) editor.handleInput("\x1b[B");
};
const enter = (editor: FormEditor): void => editor.handleInput("\r");
const type = (editor: FormEditor, text: string): void => {
  for (const char of text) editor.handleInput(char);
};

describe("form editor", () => {
  test("renders labelled fields within the width", () => {
    const draft = makeDraft();
    const editor = makeEditor(draft);
    for (const width of [50, 80, 120]) {
      const lines = editor.render(width);
      assert.ok(lines.length > 5);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    }
    assert.match(editor.render(100).join("\n"), /Test form/);
    assert.match(editor.render(100).join("\n"), /Title/);
    assert.match(editor.render(100).join("\n"), /Original/);
  });

  test("text fields are edited inline", () => {
    const draft = makeDraft();
    const actions: FormAction[] = [];
    const editor = makeEditor(draft, actions);
    enter(editor); // start editing Title
    type(editor, "X");
    assert.match(editor.render(100).join("\n"), /OriginalX/);
    editor.handleInput("\x7f"); // backspace
    enter(editor); // commit
    assert.equal(draft.title, "Original");
    editor.handleInput("s");
    assert.deepEqual(actions, [{ kind: "save" }]);
  });

  test("numbers cycle with arrows and can be typed", () => {
    const draft = makeDraft();
    const editor = makeEditor(draft);
    down(editor); // priority
    editor.handleInput("\x1b[C"); // right
    assert.equal(draft.priority, 4);
    editor.handleInput("\x1b[D");
    editor.handleInput("\x1b[D");
    assert.equal(draft.priority, 2);
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    assert.equal(draft.priority, 5, "clamped at max");

    down(editor); // probability
    editor.handleInput("\x1b[C");
    assert.equal(draft.probability, 0.55);
    enter(editor);
    type(editor, "0.2");
    enter(editor);
    assert.equal(draft.probability, 0.2);
    enter(editor);
    type(editor, "nonsense");
    enter(editor);
    assert.match(editor.render(100).join("\n"), /must be a number/);
  });

  test("enums cycle through their options", () => {
    const draft = makeDraft();
    const editor = makeEditor(draft);
    down(editor, 3); // status
    editor.handleInput("\x1b[C");
    assert.equal(draft.status, "COMPLETED");
    editor.handleInput("\x1b[C");
    assert.equal(draft.status, "FAILED");
    editor.handleInput("\x1b[C");
    assert.equal(draft.status, "ACTIVE", "wraps around");
  });

  test("lists add, edit and remove items", () => {
    const draft = makeDraft();
    const editor = makeEditor(draft);
    down(editor, 5); // criteria (empty list -> "+ add" row)
    enter(editor); // add
    type(editor, "works");
    enter(editor);
    assert.deepEqual(draft.criteria, ["works"]);

    editor.handleInput("a"); // append another via `a`
    type(editor, "fast");
    enter(editor);
    assert.deepEqual(draft.criteria, ["works", "fast"]);

    // Move to the first item and edit it.
    editor.handleInput("\x1b[A");
    assert.equal(editor.render(100).filter((line) => line.includes("fast")).length, 1);
    enter(editor);
    type(editor, "!");
    enter(editor);
    assert.deepEqual(draft.criteria, ["works!", "fast"]);

    // Remove the second item with d.
    editor.handleInput("\x1b[B");
    editor.handleInput("d");
    assert.deepEqual(draft.criteria, ["works!"]);

    // Editing a blank item and committing discards it.
    editor.handleInput("a");
    enter(editor);
    assert.deepEqual(draft.criteria, ["works!"]);
  });

  test("refs and ref fields use a picker", () => {
    const draft = makeDraft();
    const editor = makeEditor(draft);
    // Rows: title, priority, probability, status, vision, criteria(add), links[0], links(add), parent
    down(editor, 6); // links[0]
    enter(editor); // open picker
    const pickerFrame = editor.render(100).join("\n");
    assert.match(pickerFrame, /choose…/);
    assert.match(pickerFrame, /Goal one/);
    editor.handleInput("\x1b[B"); // move to G2
    enter(editor); // toggle G2 on
    assert.deepEqual(draft.links, ["G1", "G2"]);
    enter(editor); // reopen picker (still on links[0])
    enter(editor); // toggle G1 off
    assert.deepEqual(draft.links, ["G2"]);

    // Single ref: set and clear.
    down(editor, 2); // links(add) -> parent
    enter(editor);
    enter(editor); // pick G1
    assert.equal(draft.parent, "G1");
    enter(editor);
    enter(editor); // toggle off
    assert.equal(draft.parent, null);
  });

  test("prose fields delegate to the caller and required fields block saving", () => {
    const draft = makeDraft();
    const actions: FormAction[] = [];
    const editor = makeEditor(draft, actions);
    down(editor, 4); // vision (prose)
    enter(editor);
    assert.deepEqual(actions.at(-1), { kind: "edit-prose", key: "vision" });

    // Required title cannot be emptied.
    draft.title = "";
    editor.handleInput("s");
    assert.equal(actions.at(-1)?.kind, "edit-prose", "save must be blocked while title is empty");
    assert.match(editor.render(100).join("\n"), /Title is required/);
  });

  test("escape cancels and shift+D deletes", () => {
    const draft = makeDraft();
    const actions: FormAction[] = [];
    const editor = makeEditor(draft, actions);
    editor.handleInput("\x1b");
    assert.deepEqual(actions.at(-1), { kind: "cancel" });
    editor.handleInput("D");
    assert.deepEqual(actions.at(-1), { kind: "delete" });
  });

  test("formatNumber keeps small values readable", () => {
    assert.equal(formatNumber(3), "3");
    assert.equal(formatNumber(0.5), "0.5");
    assert.equal(formatNumber(0.55), "0.55");
  });
});

describe("form hierarchy", () => {
  test("exactly one row is highlighted and it follows focus", () => {
    const draft = makeDraft();
    const backgrounded: string[] = [];
    const recording = {
      fg: (_c: string, t: string) => t,
      bg: (color: string, t: string) => {
        if (color === "selectedBg") backgrounded.push(t);
        return t;
      },
      bold: (t: string) => t,
      italic: (t: string) => t,
      strikethrough: (t: string) => t,
    } as unknown as Theme;

    const fields: FormField[] = [
      { kind: "text", key: "title", label: "Title", get: () => draft.title, set: (v) => (draft.title = v) },
      { kind: "int", key: "priority", label: "Priority", min: 1, max: 5, get: () => draft.priority, set: (v) => (draft.priority = v) },
    ];
    const editor = new FormEditor({ title: "T", fields, theme: recording, getTerminalRows: () => 30, onExit: () => undefined });

    backgrounded.length = 0;
    editor.render(80);
    assert.equal(backgrounded.length, 1, "one highlighted row");
    assert.match(backgrounded[0]!, /Title/);

    backgrounded.length = 0;
    editor.handleInput("\x1b[B"); // move down
    editor.render(80);
    assert.equal(backgrounded.length, 1);
    assert.match(backgrounded[0]!, /Priority/);
  });
});

describe("unsaved-changes guard", () => {
  test("esc on a clean form closes at once; esc after an edit asks first", () => {
    const draft = makeDraft();
    const actions: FormAction[] = [];
    const editor = makeEditor(draft, actions);

    assert.equal(editor.isDirty(), false, "a freshly opened form is clean");
    editor.handleInput("\x1b"); // esc
    assert.deepEqual(actions, [{ kind: "cancel" }], "a clean form closes immediately");

    // Now change a value and try to leave.
    const dirty = makeDraft();
    const dirtyActions: FormAction[] = [];
    const dirtyEditor = makeEditor(dirty, dirtyActions);
    dirtyEditor.handleInput("\r"); // edit the title
    type(dirtyEditor, "!");
    dirtyEditor.handleInput("\r"); // confirm the field edit
    assert.equal(dirtyEditor.isDirty(), true, "an edited field marks the form dirty");

    dirtyEditor.handleInput("\x1b");
    assert.deepEqual(dirtyActions, [], "esc must not leave yet — it only asks");
    assert.match(dirtyEditor.render(80).join("\n"), /unsaved changes — y discard/);

    // n keeps editing and clears the prompt; the draft is untouched.
    dirtyEditor.handleInput("n");
    assert.deepEqual(dirtyActions, [], "declining keeps the form open");
    assert.doesNotMatch(dirtyEditor.render(80).join("\n"), /unsaved changes/);
    assert.equal(dirty.title, "Original!", "the edit is still there after declining");

    // A stray key while the prompt is up must not discard anything.
    dirtyEditor.handleInput("\x1b");
    dirtyEditor.handleInput("x");
    assert.deepEqual(dirtyActions, [], "only y or enter can discard");

    // y discards: the caller sees a cancel, so nothing is saved.
    dirtyEditor.handleInput("y");
    assert.deepEqual(dirtyActions, [{ kind: "cancel" }]);
  });

  test("edits made and reverted are clean again", () => {
    const draft = makeDraft();
    const actions: FormAction[] = [];
    const editor = makeEditor(draft, actions);
    editor.handleInput("\r");
    type(editor, "!");
    editor.handleInput("\x1b"); // esc reverts the in-progress field edit
    assert.equal(editor.isDirty(), false, "reverting the field edit restores clean");
    editor.handleInput("\x1b");
    assert.deepEqual(actions, [{ kind: "cancel" }], "no prompt for a form that matches its start");
  });
});
