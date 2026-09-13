/**
 * Priority scoring.
 *
 * Spec 6.1: a default question-priority model should consider
 *   Importance x Uncertainty x Decision impact
 * and the system must be able to answer
 *   "What is the most important thing we currently don't know?"
 *
 * Risk priority uses the spec's exposure model (probability x impact).
 */

import type { AnswerStatus, Question, Risk, RiskStatus } from "./types.ts";

export function clamp01(value: number | undefined | null, fallback = 0.5): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function clampInt(value: number | undefined | null, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Exposure = probability x impact (spec 7). */
export function riskExposure(risk: Pick<Risk, "probability" | "impact">): number {
  return round3(clamp01(risk.probability) * clamp01(risk.impact));
}

const RISK_STATUS_WEIGHT: Record<RiskStatus, number> = {
  OPEN: 1,
  MITIGATING: 0.8,
  OCCURRED: 1,
  ACCEPTED: 0.4,
  RESOLVED: 0,
  CLOSED: 0,
};

export function riskStatusWeight(status: RiskStatus): number {
  return RISK_STATUS_WEIGHT[status] ?? 0.5;
}

/** Kind of question: how much remaining uncertainty the status implies. */
export function statusUncertainty(status: AnswerStatus): number {
  switch (status) {
    case "UNKNOWN":
      return 1;
    case "PARTIAL":
      return 0.6;
    case "ANSWERED":
      return 0.3;
    case "CONFIRMED":
    case "INVALIDATED":
      return 0;
    default:
      return 1;
  }
}

/**
 * Uncertainty used for scoring. Explicit `uncertainty` wins, but an item that is
 * already CONFIRMED/INVALIDATED is never treated as uncertain.
 */
export function effectiveUncertainty(question: Question): number {
  const status = statusUncertainty(question.status);
  const explicit = clamp01(question.uncertainty, status);
  return round3(Math.min(status, explicit));
}

/**
 * Question score in 0..1. Higher = more important to answer next.
 * `importance * uncertainty * decisionImpact` with a small tie-break boost for
 * open questions so that CONFIRMED items sink below equivalent OPEN ones.
 */
export function questionScore(question: Question): number {
  const importance = clamp01(question.importance, 0.5);
  const uncertainty = effectiveUncertainty(question);
  const impact = clamp01(question.decisionImpact, 0.5);
  const openBoost = question.status === "UNKNOWN" || question.status === "PARTIAL" ? 1 : 0.85;
  return round3(importance * uncertainty * impact * openBoost);
}

/** Risk score in 0..1 honouring status (resolved risks drop out). */
export function riskScore(risk: Risk): number {
  return round3(riskExposure(risk) * riskStatusWeight(risk.status));
}

export function byQuestionPriority<T extends Question>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const diff = questionScore(b) - questionScore(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return idNumber(a.id) - idNumber(b.id);
  });
}

export function byRiskPriority<T extends Risk>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const diff = riskScore(b) - riskScore(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return idNumber(a.id) - idNumber(b.id);
  });
}

export function isOpenQuestion(question: Question): boolean {
  return question.status === "UNKNOWN" || question.status === "PARTIAL";
}

export function idNumber(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/** Map a 0..1 score onto the coarse LOW/MEDIUM/HIGH/CRITICAL vocabulary used in the TUI. */
export function scoreBand(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 0.6) return "CRITICAL";
  if (score >= 0.35) return "HIGH";
  if (score >= 0.15) return "MEDIUM";
  return "LOW";
}

/** Map a 1..5 priority onto the coarse vocabulary. */
export function priorityBand(priority: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (priority >= 5) return "CRITICAL";
  if (priority >= 4) return "HIGH";
  if (priority >= 3) return "MEDIUM";
  return "LOW";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
