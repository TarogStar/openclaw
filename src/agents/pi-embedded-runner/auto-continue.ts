import type { AutoContinueConfig } from "../../config/types.auto-continue.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

/** Default synthetic prompt when the operator has not customized one. */
export const DEFAULT_AUTO_CONTINUE_PROMPT = "Use your best judgement and continue.";

/** Hard ceiling to prevent runaway loops unless the operator raises it. */
export const DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS = 20;

/** Default terminal signals. The PM skill teaches the model to emit these. */
export const DEFAULT_AUTO_CONTINUE_STOP_SIGNALS = Object.freeze([
  "PIPELINE_IDLE",
  "BLOCKED",
  "CYCLE_RESET",
  "TASK_COMPLETE",
  "AWAITING_HUMAN",
] as const);

/**
 * Resolved + merged auto-continue config. All fields are concrete (no undefined)
 * so consumer code doesn't need to defend against missing defaults.
 */
export type ResolvedAutoContinueConfig = {
  enabled: boolean;
  maxIterations: number;
  prompt: string;
  stopOnSignals: string[];
  stopOnToolCall: string[];
  cooldownMs: number;
  continueOnEmpty: boolean;
};

/**
 * Merge agents.defaults.autoContinue with the per-agent override, then fill in
 * hard defaults so the consumer gets a complete shape.
 *
 * Per-agent override takes precedence. Arrays are replaced, not concatenated —
 * this matches the OpenClaw config convention for list-shaped overrides.
 */
export function resolveAutoContinueConfig(params: {
  cfg: OpenClawConfig | undefined;
  agentId: string | undefined;
}): ResolvedAutoContinueConfig {
  const defaults = params.cfg?.agents?.defaults?.autoContinue;
  const entry = params.agentId
    ? params.cfg?.agents?.list?.find((a) => a.id === params.agentId)?.autoContinue
    : undefined;

  const merged: AutoContinueConfig = {
    ...defaults,
    ...entry,
  };

  return {
    enabled: merged.enabled === true,
    maxIterations:
      typeof merged.maxIterations === "number" && merged.maxIterations > 0
        ? Math.floor(merged.maxIterations)
        : DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS,
    prompt:
      typeof merged.prompt === "string" && merged.prompt.trim().length > 0
        ? merged.prompt
        : DEFAULT_AUTO_CONTINUE_PROMPT,
    stopOnSignals:
      Array.isArray(merged.stopOnSignals) && merged.stopOnSignals.length > 0
        ? merged.stopOnSignals.slice()
        : [...DEFAULT_AUTO_CONTINUE_STOP_SIGNALS],
    stopOnToolCall: Array.isArray(merged.stopOnToolCall) ? merged.stopOnToolCall.slice() : [],
    cooldownMs:
      typeof merged.cooldownMs === "number" && merged.cooldownMs >= 0
        ? Math.floor(merged.cooldownMs)
        : 0,
    continueOnEmpty: merged.continueOnEmpty === true,
  };
}

/** Reasons auto-continue declines to fire. Useful for structured logging. */
export type AutoContinueDecision =
  | { continue: true }
  | {
      continue: false;
      reason:
        | "disabled"
        | "iteration-cap"
        | "attempt-errored"
        | "tool-load-takes-precedence"
        | "yield-takes-precedence"
        | "client-tool-takes-precedence"
        | "tool-called"
        | "stop-on-tool-call"
        | "stop-signal"
        | "empty-output";
    };

/**
 * Decide whether to inject a synthetic user prompt for the next attempt.
 *
 * Returns { continue: true } when:
 *  - Auto-continue is enabled
 *  - Iteration cap not reached
 *  - Attempt did not error/abort/timeout
 *  - No existing continuation path already handled this turn
 *    (toolLoadRequested, yieldDetected, clientToolCall)
 *  - No tool was called this turn (if a tool was called, the existing loop
 *    already processes the next turn via tool-result flow)
 *  - No configured stop signal appears in the assistant text
 *  - No configured stop-on-tool-call matched
 *  - Assistant text is non-empty (unless continueOnEmpty is true)
 */
export function shouldAutoContinue(params: {
  attempt: EmbeddedRunAttemptResult;
  autoContinueCfg: ResolvedAutoContinueConfig;
  iterations: number;
}): AutoContinueDecision {
  const { attempt, autoContinueCfg, iterations } = params;

  if (!autoContinueCfg.enabled) {
    return { continue: false, reason: "disabled" };
  }
  if (iterations >= autoContinueCfg.maxIterations) {
    return { continue: false, reason: "iteration-cap" };
  }
  if (attempt.aborted || attempt.promptError != null || attempt.timedOut || attempt.idleTimedOut) {
    return { continue: false, reason: "attempt-errored" };
  }
  if (attempt.toolLoadRequested && attempt.toolLoadRequested.length > 0) {
    return { continue: false, reason: "tool-load-takes-precedence" };
  }
  if (attempt.yieldDetected) {
    return { continue: false, reason: "yield-takes-precedence" };
  }
  if (attempt.clientToolCall) {
    return { continue: false, reason: "client-tool-takes-precedence" };
  }

  if (autoContinueCfg.stopOnToolCall.length > 0 && attempt.toolMetas.length > 0) {
    const toolNames = new Set(attempt.toolMetas.map((m) => m.toolName));
    for (const stop of autoContinueCfg.stopOnToolCall) {
      if (toolNames.has(stop)) {
        return { continue: false, reason: "stop-on-tool-call" };
      }
    }
  }

  if (attempt.toolMetas.length > 0) {
    // A tool was called; the existing run-loop paths drive the next turn via
    // the tool-result flow. Auto-continue stays out of the way.
    return { continue: false, reason: "tool-called" };
  }

  const assistantText = extractAssistantText(attempt);
  if (!assistantText) {
    if (!autoContinueCfg.continueOnEmpty) {
      return { continue: false, reason: "empty-output" };
    }
  } else {
    for (const signal of autoContinueCfg.stopOnSignals) {
      if (assistantText.includes(signal)) {
        return { continue: false, reason: "stop-signal" };
      }
    }
  }

  return { continue: true };
}

function extractAssistantText(attempt: EmbeddedRunAttemptResult): string {
  if (attempt.assistantTexts.length > 0) {
    return attempt.assistantTexts.join("\n");
  }
  const last = attempt.lastAssistant;
  if (!last) {
    return "";
  }
  const content = (last as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") {
          return c;
        }
        if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
          return c.text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}
