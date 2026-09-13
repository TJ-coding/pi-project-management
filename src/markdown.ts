/**
 * Human-readable markdown helpers.
 *
 * The project is stored as plain markdown + YAML so it stays readable and
 * diffable outside Pi (spec 19). These helpers do the small amount of
 * section/bullet/front-matter parsing the model needs.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function parseSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== null) sections.set(current.toLowerCase(), buffer.join("\n").trim());
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1]!.trim();
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

export function section(sections: Map<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = sections.get(name.toLowerCase());
    if (value !== undefined) return value;
  }
  return "";
}

export function renderSections(title: string, entries: Array<[string, string]>): string {
  const parts = [`# ${title}`];
  for (const [heading, body] of entries) {
    parts.push(`## ${heading}\n`);
    parts.push(body.trim() === "" ? "_None yet._" : body.trim());
  }
  return parts.join("\n\n") + "\n";
}

/** Parse a markdown bullet list into an array of single-line strings. */
export function parseBullets(text: string): string[] {
  if (!text || text.trim() === "" || text.trim() === "_None yet._") return [];
  const out: string[] = [];
  let current: string | null = null;

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (current !== null) out.push(current.trim());
      current = bullet[1]!.trim();
    } else if (current !== null && line.trim() !== "") {
      // Continuation of a wrapped bullet.
      current = `${current} ${line.trim()}`;
    } else if (line.trim() === "" && current !== null) {
      out.push(current.trim());
      current = null;
    }
  }
  if (current !== null) out.push(current.trim());
  return out.filter((item) => item !== "");
}

export function renderBullets(items: readonly string[]): string {
  if (items.length === 0) return "_None yet._";
  return items.map((item) => `- ${item.replace(/\n+/g, " ")}`).join("\n");
}

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontMatter(text: string): FrontMatter {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(match[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: normalized.slice(match[0].length) };
}

export function renderFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data, { lineWidth: 100 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/** Parse `- [type] text` concept bullets. */
export function parseConcepts(text: string): Array<{ type: string; text: string }> {
  return parseBullets(text).map((item) => {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(item);
    if (match) return { type: match[1]!.trim().toLowerCase(), text: match[2]!.trim() };
    return { type: "concept", text: item };
  });
}

export function renderConcepts(concepts: ReadonlyArray<{ type: string; text: string }>): string {
  if (concepts.length === 0) return "_None yet._";
  return concepts.map((concept) => `- [${concept.type}] ${concept.text.replace(/\n+/g, " ")}`).join("\n");
}

/** Trim/normalize model-supplied prose so files stay tidy. */
export function cleanProse(text: string | undefined | null): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
