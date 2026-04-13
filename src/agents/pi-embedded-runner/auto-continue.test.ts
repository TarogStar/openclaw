import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS,
  DEFAULT_AUTO_CONTINUE_PROMPT,
  DEFAULT_AUTO_CONTINUE_STOP_SIGNALS,
  resolveAutoContinueConfig,
  shouldAutoContinue,
} from "./auto-continue.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

/**
 * Minimal EmbeddedRunAttemptResult factory. Tests override only the fields they
 * assert on; everything else gets inert defaults so the shape is complete.
 */
function makeAttempt(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "test-session",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {} as unknown as EmbeddedRunAttemptResult["replayMetadata"],
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

describe("resolveAutoContinueConfig", () => {
  it("returns full defaults when nothing is configured", () => {
    const resolved = resolveAutoContinueConfig({ cfg: undefined, agentId: undefined });
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxIterations).toBe(DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS);
    expect(resolved.prompt).toBe(DEFAULT_AUTO_CONTINUE_PROMPT);
    expect(resolved.stopOnSignals).toEqual([...DEFAULT_AUTO_CONTINUE_STOP_SIGNALS]);
    expect(resolved.stopOnToolCall).toEqual([]);
    expect(resolved.cooldownMs).toBe(0);
    expect(resolved.continueOnEmpty).toBe(false);
  });

  it("uses agents.defaults.autoContinue when no per-agent override exists", () => {
    const cfg = {
      agents: {
        defaults: {
          autoContinue: {
            enabled: true,
            maxIterations: 5,
            prompt: "Keep going.",
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveAutoContinueConfig({ cfg, agentId: "main" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxIterations).toBe(5);
    expect(resolved.prompt).toBe("Keep going.");
  });

  it("per-agent override shadows defaults field-by-field", () => {
    const cfg = {
      agents: {
        defaults: {
          autoContinue: { enabled: true, maxIterations: 10, prompt: "Default prompt" },
        },
        list: [
          {
            id: "design",
            autoContinue: { maxIterations: 3 },
          },
        ],
      },
    } as OpenClawConfig;
    const resolved = resolveAutoContinueConfig({ cfg, agentId: "design" });
    expect(resolved.enabled).toBe(true); // inherited
    expect(resolved.maxIterations).toBe(3); // overridden
    expect(resolved.prompt).toBe("Default prompt"); // inherited
  });

  it("per-agent disable overrides a default-enabled config", () => {
    const cfg = {
      agents: {
        defaults: { autoContinue: { enabled: true } },
        list: [{ id: "design", autoContinue: { enabled: false } }],
      },
    } as OpenClawConfig;
    expect(resolveAutoContinueConfig({ cfg, agentId: "design" }).enabled).toBe(false);
  });

  it("ignores non-positive maxIterations and substitutes the default", () => {
    const cfg = {
      agents: { defaults: { autoContinue: { enabled: true, maxIterations: 0 } } },
    } as OpenClawConfig;
    expect(resolveAutoContinueConfig({ cfg, agentId: undefined }).maxIterations).toBe(
      DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS,
    );
  });

  it("ignores empty/whitespace prompts and substitutes the default", () => {
    const cfg = {
      agents: { defaults: { autoContinue: { enabled: true, prompt: "   " } } },
    } as OpenClawConfig;
    expect(resolveAutoContinueConfig({ cfg, agentId: undefined }).prompt).toBe(
      DEFAULT_AUTO_CONTINUE_PROMPT,
    );
  });

  it("copies array fields so callers can't mutate the resolved config into defaults", () => {
    const defaults = [...DEFAULT_AUTO_CONTINUE_STOP_SIGNALS];
    const resolved = resolveAutoContinueConfig({ cfg: undefined, agentId: undefined });
    resolved.stopOnSignals.push("SHOULD_NOT_LEAK");
    // Pull defaults again and confirm they were not mutated.
    const resolved2 = resolveAutoContinueConfig({ cfg: undefined, agentId: undefined });
    expect(resolved2.stopOnSignals).toEqual(defaults);
  });
});

describe("shouldAutoContinue", () => {
  const enabledCfg = {
    enabled: true,
    maxIterations: 10,
    prompt: "continue",
    stopOnSignals: ["TASK_COMPLETE", "BLOCKED"],
    stopOnToolCall: [],
    cooldownMs: 0,
    continueOnEmpty: false,
  };

  it("fires when enabled, no tool call, non-empty text without stop signal", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: ["I finished that step."] }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result.continue).toBe(true);
  });

  it("does not fire when disabled", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: ["anything"] }),
      autoContinueCfg: { ...enabledCfg, enabled: false },
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "disabled" });
  });

  it("stops at iteration cap", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: ["ok"] }),
      autoContinueCfg: enabledCfg,
      iterations: 10,
    });
    expect(result).toEqual({ continue: false, reason: "iteration-cap" });
  });

  it("stops when attempt aborted", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ aborted: true, assistantTexts: ["ok"] }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "attempt-errored" });
  });

  it("stops when prompt errored", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        promptError: new Error("nope"),
        promptErrorSource: "prompt",
        assistantTexts: ["ok"],
      }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "attempt-errored" });
  });

  it("stops when tool_load took precedence", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        toolLoadRequested: ["web_fetch"],
        assistantTexts: ["loading"],
      }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "tool-load-takes-precedence" });
  });

  it("stops when a tool was called this turn (normal tool flow drives next turn)", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        toolMetas: [{ toolName: "read" }],
        assistantTexts: ["reading..."],
      }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "tool-called" });
  });

  it("stops when stopOnToolCall matches", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        toolMetas: [{ toolName: "sessions_send_final" }],
        assistantTexts: ["done"],
      }),
      autoContinueCfg: { ...enabledCfg, stopOnToolCall: ["sessions_send_final"] },
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "stop-on-tool-call" });
  });

  it("stops when assistant text contains a stop signal", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: ["All work is done. TASK_COMPLETE"] }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "stop-signal" });
  });

  it("stops on empty output by default", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: [] }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "empty-output" });
  });

  it("fires on empty output when continueOnEmpty is true", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: [] }),
      autoContinueCfg: { ...enabledCfg, continueOnEmpty: true },
      iterations: 0,
    });
    expect(result).toEqual({ continue: true });
  });

  it("stop signals are case-sensitive substrings (won't fire on lowercase)", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({ assistantTexts: ["task_complete"] }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result.continue).toBe(true);
  });

  it("reads lastAssistant.content when assistantTexts is empty", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        assistantTexts: [],
        lastAssistant: {
          content: [{ type: "text", text: "keep going and be thorough" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result.continue).toBe(true);
  });

  it("still detects stop signals in lastAssistant.content fallback", () => {
    const result = shouldAutoContinue({
      attempt: makeAttempt({
        assistantTexts: [],
        lastAssistant: {
          content: [{ type: "text", text: "BLOCKED — nothing to do" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
      autoContinueCfg: enabledCfg,
      iterations: 0,
    });
    expect(result).toEqual({ continue: false, reason: "stop-signal" });
  });
});
