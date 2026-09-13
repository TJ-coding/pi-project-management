import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  byQuestionPriority,
  byRiskPriority,
  effectiveUncertainty,
  questionScore,
  riskExposure,
  riskScore,
  scoreBand,
} from "../src/scoring.ts";
import type { Question, Risk } from "../src/types.ts";

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "Q1",
    question: "?",
    answer: "",
    status: "UNKNOWN",
    importance: 0.5,
    uncertainty: 0.5,
    decisionImpact: 0.5,
    confidence: 0,
    evidence: [],
    goals: [],
    risks: [],
    tasks: [],
    decisions: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    answered: null,
    ...overrides,
  };
}

function risk(overrides: Partial<Risk> = {}): Risk {
  return {
    id: "R1",
    title: "risk",
    description: "",
    probability: 0.5,
    impact: 0.5,
    status: "OPEN",
    mitigation: "",
    contingency: "",
    questions: [],
    goals: [],
    tasks: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("scoring", () => {
  test("risk exposure is probability x impact", () => {
    assert.equal(riskExposure({ probability: 0.4, impact: 0.9 }), 0.36);
    assert.equal(riskExposure({ probability: 2, impact: 2 }), 1);
  });

  test("resolved risks score zero", () => {
    assert.equal(riskScore(risk({ status: "RESOLVED", probability: 1, impact: 1 })), 0);
    assert.ok(riskScore(risk({ status: "OPEN", probability: 0.8, impact: 0.8 })) > 0);
  });

  test("question score multiplies importance, uncertainty and decision impact", () => {
    const q = question({ importance: 0.9, uncertainty: 0.8, decisionImpact: 0.7 });
    assert.equal(questionScore(q), Number((0.9 * 0.8 * 0.7).toFixed(3)));
  });

  test("answered questions are less uncertain than open ones", () => {
    const open = question({ status: "UNKNOWN", uncertainty: 1 });
    const partial = question({ status: "PARTIAL", uncertainty: 1 });
    const answered = question({ status: "ANSWERED", uncertainty: 1 });
    const confirmed = question({ status: "CONFIRMED", uncertainty: 1 });
    assert.equal(effectiveUncertainty(open), 1);
    assert.equal(effectiveUncertainty(partial), 0.6);
    assert.equal(effectiveUncertainty(answered), 0.3);
    assert.equal(effectiveUncertainty(confirmed), 0);
    assert.ok(questionScore(open) > questionScore(answered));
    assert.equal(questionScore(confirmed), 0);
  });

  test("priority ordering puts the most important unknown first", () => {
    const questions = [
      question({ id: "Q1", importance: 0.2, uncertainty: 1, decisionImpact: 0.2 }),
      question({ id: "Q2", importance: 1, uncertainty: 1, decisionImpact: 1 }),
      question({ id: "Q3", importance: 0.6, uncertainty: 1, decisionImpact: 0.6 }),
    ];
    assert.deepEqual(byQuestionPriority(questions).map((q) => q.id), ["Q2", "Q3", "Q1"]);
  });

  test("risk ordering uses exposure and status", () => {
    const risks = [
      risk({ id: "R1", probability: 0.2, impact: 0.2 }),
      risk({ id: "R2", probability: 0.9, impact: 0.9 }),
      risk({ id: "R3", probability: 1, impact: 1, status: "RESOLVED" }),
    ];
    assert.deepEqual(byRiskPriority(risks).map((r) => r.id), ["R2", "R1", "R3"]);
  });

  test("score bands are stable", () => {
    assert.equal(scoreBand(0.9), "CRITICAL");
    assert.equal(scoreBand(0.4), "HIGH");
    assert.equal(scoreBand(0.2), "MEDIUM");
    assert.equal(scoreBand(0.01), "LOW");
  });
});
