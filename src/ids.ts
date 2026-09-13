/** Small helpers for stable, human-friendly identifiers. */

const PREFIX = {
  goal: "G",
  question: "Q",
  risk: "R",
  node: "N",
  plan: "P",
  decision: "D",
  run: "RUN",
} as const;

export type IdKind = keyof typeof PREFIX;

/**
 * Next id for a collection using the given kind prefix (`G1`, `G2`, ...).
 * IDs are never reused inside a project even if an item is removed.
 */
export function nextId(kind: IdKind, existing: readonly string[]): string {
  const prefix = PREFIX[kind];
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const n = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/** Stable slug used for filenames and project ids. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

/** Deterministic short hash (djb2) used to disambiguate project ids. */
export function shortHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(4, "0").slice(0, 6);
}

/** Current time as an ISO string. Kept in one place so tests can reason about it. */
export function now(clock?: () => Date): string {
  return (clock ? clock() : new Date()).toISOString();
}
