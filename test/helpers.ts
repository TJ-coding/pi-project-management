import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/storage.ts";

export async function tempDir(prefix = "pi-pm-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Deterministic, monotonically increasing ISO clock. */
export function fixedClock(start = "2026-01-01T00:00:00.000Z"): Clock & { tick: () => string; set: (iso: string) => void } {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    tick: () => {
      current += 1000;
      return new Date(current).toISOString();
    },
    set: (iso: string) => {
      current = Date.parse(iso);
    },
  };
}
