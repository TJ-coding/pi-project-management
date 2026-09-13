/**
 * Human editing (spec 2.4: humans and agents share the same operations).
 *
 * Every editable section is defined once here: how to render its exact source
 * text, and how to parse that text back into the model. The TUI `e` key and
 * `/project edit <section>` both use this registry, so a hand edit goes through
 * the same validation, history and Git path as an agent-driven change.
 *
 * The source text is exactly what lives in `.project/`: markdown for direction,
 * state and strategy, YAML for goals, intelligence, risks and plan. Editing the
 * text is therefore also a way to learn the on-disk format.
 */

import {
  parseDirection,
  parseGoals,
  parsePlans,
  parseQuestions,
  parseRisks,
  parseState,
  parseStrategy,
  serializeDirection,
  serializeGoals,
  serializePlans,
  serializeQuestions,
  serializeRisks,
  serializeState,
  serializeStrategy,
  type Clock,
} from "./storage.ts";
import type { ProjectManager } from "./project.ts";
import type { Project } from "./types.ts";

export interface EditContext {
  approved?: boolean;
  approvedBy?: string;
  clock?: Clock;
}

export interface EditableSection {
  /** Section id, also used as the command argument (`/project edit goals`). */
  id: string;
  /** Dashboard view this section belongs to (for the `e` key). */
  view: string;
  label: string;
  /** Path inside `.project/` (shown in the editor title and document header). */
  file: string;
  kind: "markdown" | "yaml";
  /** Changing this section is a strategic change (needs approval outside YOLO). */
  strategic: boolean;
  /** Current source text. */
  read: (project: Project) => string;
  /** Parse + apply, returning a one-line summary. Throws on invalid text. */
  apply: (manager: ProjectManager, text: string, context: EditContext) => Promise<string>;
}

/** Header comment prepended to YAML documents so the format is self-explaining. */
function yamlHeaderFor(label: string, file: string): string {
  return [
    `# ${label} — ${file}`,
    "# Edit this list and save. Saving goes through validation, history and Git.",
    "# Fields: see /project help or README. Keep existing ids to preserve links.",
    "",
  ].join("\n");
}

export const EDITABLE_SECTIONS: EditableSection[] = [
  {
    id: "direction",
    view: "direction",
    label: "Direction",
    file: "direction.md",
    kind: "markdown",
    strategic: true,
    read: (project) => serializeDirection(project.direction),
    apply: async (manager, text, context) => {
      const parsed = parseDirection(text);
      const outcome = await manager.updateDirection(parsed, {
        approved: context.approved,
        approvedBy: context.approvedBy,
        reason: "edited by hand",
      });
      if (outcome.status === "requires-approval") throw new Error(outcome.message);
      return "Direction updated by hand";
    },
  },
  {
    id: "state",
    view: "state",
    label: "State",
    file: "state.md",
    kind: "markdown",
    strategic: false,
    read: (project) => serializeState(project.state),
    apply: async (manager, text, context) => {
      const parsed = parseState(text, context.clock);
      await manager.updateState(
        {
          initial: parsed.initial,
          current: parsed.current,
          capabilities: parsed.capabilities,
          facts: parsed.facts,
          problems: parsed.problems,
          constraints: parsed.constraints,
          discoveries: parsed.discoveries,
        },
        { summary: "state edited by hand" },
      );
      return "State updated by hand";
    },
  },
  {
    id: "strategy",
    view: "strategy",
    label: "Strategy",
    file: "strategy.md",
    kind: "markdown",
    strategic: false,
    read: (project) => serializeStrategy(project.strategy),
    apply: async (manager, text, context) => {
      const parsed = parseStrategy(text);
      await manager.setStrategy(parsed, { reason: "strategy edited by hand" });
      void context;
      return "Strategy updated by hand";
    },
  },
  {
    id: "goals",
    view: "goals",
    label: "Goals",
    file: "goals.yaml",
    kind: "yaml",
    strategic: false,
    read: (project) => yamlHeaderFor("Goals", "goals.yaml") + serializeGoals(project.goals),
    apply: async (manager, text, context) => {
      const goals = parseGoals(text, context.clock);
      await manager.replaceGoals(goals);
      return `${goals.length} goal(s) saved by hand`;
    },
  },
  {
    id: "intelligence",
    view: "intelligence",
    label: "Intelligence (questions)",
    file: "intelligence.yaml",
    kind: "yaml",
    strategic: false,
    read: (project) => yamlHeaderFor("Intelligence (questions)", "intelligence.yaml") + serializeQuestions(project.questions),
    apply: async (manager, text, context) => {
      const questions = parseQuestions(text, context.clock);
      await manager.replaceQuestions(questions);
      return `${questions.length} question(s) saved by hand`;
    },
  },
  {
    id: "risks",
    view: "risks",
    label: "Risks",
    file: "risks.yaml",
    kind: "yaml",
    strategic: false,
    read: (project) => yamlHeaderFor("Risks", "risks.yaml") + serializeRisks(project.risks),
    apply: async (manager, text, context) => {
      const risks = parseRisks(text, context.clock);
      await manager.replaceRisks(risks);
      return `${risks.length} risk(s) saved by hand`;
    },
  },
  {
    id: "plan",
    view: "plan",
    label: "Plan / DAG",
    file: "plan.yaml",
    kind: "yaml",
    strategic: false,
    read: (project) => serializePlans(project.plans),
    apply: async (manager, text, context) => {
      const plans = parsePlans(text, context.clock);
      await manager.replacePlans(plans);
      return `${plans.plans.length} plan version(s) saved by hand`;
    },
  },
];

export function editableSection(id: string): EditableSection | undefined {
  const key = id.trim().toLowerCase();
  return EDITABLE_SECTIONS.find((section) => section.id === key || section.view === key);
}

export function editableForView(view: string): EditableSection | undefined {
  return EDITABLE_SECTIONS.find((section) => section.view === view);
}

export function editableSectionIds(): string[] {
  return EDITABLE_SECTIONS.map((section) => section.id);
}
