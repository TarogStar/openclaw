import { describe, expect, it, vi } from "vitest";
import {
  buildReviewerInput,
  DEFAULT_REVIEWER_HISTORY_TURNS,
  DEFAULT_REVIEWER_PROMPT,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  directiveToPmPrompt,
  extractRecentHistory,
  parseReviewerDirective,
  resolveAutoContinueSyntheticPrompt,
  resolveReviewerConfig,
  reviewerOutputToPmPrompt,
  type SpawnReviewerFn,
} from "./auto-continue-reviewer.js";
import type { ResolvedAutoContinueConfig } from "./auto-continue.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

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

const baseAutoContinue: ResolvedAutoContinueConfig = {
  enabled: true,
  maxIterations: 20,
  prompt: "canned-default",
  stopOnSignals: ["BLOCKED"],
  stopOnToolCall: [],
  cooldownMs: 0,
  continueOnEmpty: false,
};

describe("parseReviewerDirective", () => {
  it("parses a single CONTINUE directive", () => {
    expect(parseReviewerDirective("CONTINUE: Run task 2 next.")).toEqual({
      kind: "continue",
      body: "Run task 2 next.",
    });
  });

  it("parses VERIFY", () => {
    expect(parseReviewerDirective("VERIFY: ls ~/repos/Curo/test.ts")).toEqual({
      kind: "verify",
      body: "ls ~/repos/Curo/test.ts",
    });
  });

  it("parses BLOCK", () => {
    expect(parseReviewerDirective("BLOCK: subagent stuck in loop")).toEqual({
      kind: "block",
      body: "subagent stuck in loop",
    });
  });

  it("scans backwards for the LAST directive line so a narrating reviewer still works", () => {
    const reviewerOutput = `Looking at the recent turns, the PM claimed work done.
Let me think about what to instruct.
The right call is to verify before continuing.

CONTINUE: should not pick this earlier line
VERIFY: ls ~/repos/Curo/expected.ts`;
    expect(parseReviewerDirective(reviewerOutput)).toEqual({
      kind: "verify",
      body: "ls ~/repos/Curo/expected.ts",
    });
  });

  it("returns null when no directive present", () => {
    expect(parseReviewerDirective("Just some text without any directive")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseReviewerDirective("")).toBeNull();
  });

  it("returns null when directive has empty body", () => {
    expect(parseReviewerDirective("CONTINUE: ")).toBeNull();
    expect(parseReviewerDirective("VERIFY:")).toBeNull();
  });

  it("trims directive bodies", () => {
    expect(parseReviewerDirective("CONTINUE:    do the thing   ")).toEqual({
      kind: "continue",
      body: "do the thing",
    });
  });
});

describe("directiveToPmPrompt", () => {
  it("wraps CONTINUE with the supervisor-directive prefix", () => {
    const prompt = directiveToPmPrompt({ kind: "continue", body: "spawn QA" });
    expect(prompt).toContain("[supervisor directive]");
    expect(prompt).toContain("spawn QA");
  });

  it("wraps VERIFY with verification-prefixed instructions", () => {
    const prompt = directiveToPmPrompt({ kind: "verify", body: "ls /path" });
    expect(prompt).toContain("Before continuing, verify");
    expect(prompt).toContain("ls /path");
  });

  it("wraps BLOCK with mandatory BLOCKED output instruction", () => {
    const prompt = directiveToPmPrompt({ kind: "block", body: "stuck" });
    expect(prompt).toContain("Mark pipeline BLOCKED");
    expect(prompt).toContain("stuck");
    expect(prompt).toContain('"BLOCKED:');
  });
});

describe("reviewerOutputToPmPrompt", () => {
  it("returns the wrapped prompt for parseable output", () => {
    expect(reviewerOutputToPmPrompt("CONTINUE: keep going")).toContain("Continue: keep going");
  });

  it("returns null when reviewer output is unparseable", () => {
    expect(reviewerOutputToPmPrompt("nonsense without directives")).toBeNull();
  });
});

describe("extractRecentHistory", () => {
  it("uses assistantTexts when available", () => {
    const out = extractRecentHistory(
      makeAttempt({ assistantTexts: ["first turn", "second turn", "third turn"] }),
      2,
    );
    expect(out).toContain("--- turn 2 ---");
    expect(out).toContain("third turn");
    expect(out).toContain("second turn");
    expect(out).not.toContain("first turn"); // truncated by `turns` arg
  });

  it("falls back to messagesSnapshot.assistant entries when assistantTexts empty", () => {
    const out = extractRecentHistory(
      makeAttempt({
        assistantTexts: [],
        messagesSnapshot: [
          { role: "user", content: "ignored" } as never,
          { role: "assistant", content: "from snapshot" } as never,
        ],
      }),
      5,
    );
    expect(out).toContain("from snapshot");
  });

  it("returns placeholder when no assistant output present", () => {
    expect(extractRecentHistory(makeAttempt(), 5)).toBe("(no recent assistant output)");
  });
});

describe("buildReviewerInput", () => {
  it("interpolates all placeholders", () => {
    const result = buildReviewerInput({
      template: DEFAULT_REVIEWER_PROMPT,
      history: "MAIN-HIST",
      process: "PROC-RULES",
      iteration: 3,
      maxIterations: 30,
      historyCount: 5,
    });
    expect(result).toContain("MAIN-HIST");
    expect(result).toContain("PROC-RULES");
    expect(result).toContain("iteration 3 of 30");
    expect(result).toContain("(5 most recent)");
  });

  it("falls back to placeholder when history is empty", () => {
    const result = buildReviewerInput({
      template: "H={HISTORY} P={PROCESS}",
      history: "",
      process: "",
      iteration: 1,
      maxIterations: 1,
      historyCount: 5,
    });
    expect(result).toBe("H=(no recent assistant output) P=(no process file configured)");
  });
});

describe("resolveReviewerConfig", () => {
  it("returns null when reviewerAgentId is unset", () => {
    expect(resolveReviewerConfig(baseAutoContinue)).toBeNull();
  });

  it("fills defaults for unset reviewer fields", () => {
    const cfg = resolveReviewerConfig({
      ...baseAutoContinue,
      reviewerAgentId: "supervisor",
    });
    expect(cfg).toEqual({
      agentId: "supervisor",
      template: DEFAULT_REVIEWER_PROMPT,
      processPath: undefined,
      timeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS,
      historyTurns: DEFAULT_REVIEWER_HISTORY_TURNS,
    });
  });

  it("respects custom values", () => {
    const cfg = resolveReviewerConfig({
      ...baseAutoContinue,
      reviewerAgentId: "supervisor",
      reviewerPrompt: "custom template",
      reviewerProcessPath: "~/.openclaw/skills/curo365-pipeline/SKILL.md",
      reviewerTimeoutMs: 30_000,
      reviewerHistoryTurns: 3,
    });
    expect(cfg).toEqual({
      agentId: "supervisor",
      template: "custom template",
      processPath: "~/.openclaw/skills/curo365-pipeline/SKILL.md",
      timeoutMs: 30_000,
      historyTurns: 3,
    });
  });

  it("rejects invalid timeout/historyTurns and uses defaults", () => {
    const cfg = resolveReviewerConfig({
      ...baseAutoContinue,
      reviewerAgentId: "supervisor",
      reviewerTimeoutMs: 0,
      reviewerHistoryTurns: -1,
    });
    expect(cfg?.timeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS);
    expect(cfg?.historyTurns).toBe(DEFAULT_REVIEWER_HISTORY_TURNS);
  });
});

describe("resolveAutoContinueSyntheticPrompt", () => {
  it("returns canned prompt when reviewerCfg is null", async () => {
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: null,
      attempt: makeAttempt({ assistantTexts: ["something"] }),
      iteration: 1,
      spawnReviewer: vi.fn() as unknown as SpawnReviewerFn,
    });
    expect(result).toBe("canned-default");
  });

  it("returns canned prompt when spawnReviewer is null even if reviewer configured", async () => {
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: {
        agentId: "supervisor",
        template: DEFAULT_REVIEWER_PROMPT,
        processPath: undefined,
        timeoutMs: 5000,
        historyTurns: 3,
      },
      attempt: makeAttempt({ assistantTexts: ["something"] }),
      iteration: 1,
      spawnReviewer: null,
    });
    expect(result).toBe("canned-default");
  });

  it("returns the wrapped supervisor directive on a parseable response", async () => {
    const spawnReviewer: SpawnReviewerFn = vi
      .fn()
      .mockResolvedValue("CONTINUE: spawn dev for task 2");
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: {
        agentId: "supervisor",
        template: "{HISTORY}",
        processPath: undefined,
        timeoutMs: 5000,
        historyTurns: 3,
      },
      attempt: makeAttempt({ assistantTexts: ["main agent text"] }),
      iteration: 2,
      spawnReviewer,
    });
    expect(result).toContain("Continue: spawn dev for task 2");
    expect(spawnReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "supervisor", timeoutMs: 5000 }),
    );
  });

  it("falls back to canned prompt when supervisor throws", async () => {
    const spawnReviewer: SpawnReviewerFn = vi.fn().mockRejectedValue(new Error("kaboom"));
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: {
        agentId: "supervisor",
        template: "{HISTORY}",
        processPath: undefined,
        timeoutMs: 5000,
        historyTurns: 3,
      },
      attempt: makeAttempt({ assistantTexts: ["x"] }),
      iteration: 1,
      spawnReviewer,
      log,
    });
    expect(result).toBe("canned-default");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reviewer spawn failed"));
  });

  it("falls back to canned prompt when supervisor returns unparseable output", async () => {
    const spawnReviewer: SpawnReviewerFn = vi
      .fn()
      .mockResolvedValue("just narration, no directive");
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: {
        agentId: "supervisor",
        template: "{HISTORY}",
        processPath: undefined,
        timeoutMs: 5000,
        historyTurns: 3,
      },
      attempt: makeAttempt({ assistantTexts: ["x"] }),
      iteration: 1,
      spawnReviewer,
      log,
    });
    expect(result).toBe("canned-default");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unparseable output"));
  });

  it("falls back to canned prompt when supervisor exceeds timeout", async () => {
    const spawnReviewer: SpawnReviewerFn = () =>
      new Promise((resolve) => setTimeout(() => resolve("CONTINUE: too late"), 200));
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await resolveAutoContinueSyntheticPrompt({
      autoContinueCfg: baseAutoContinue,
      reviewerCfg: {
        agentId: "supervisor",
        template: "{HISTORY}",
        processPath: undefined,
        timeoutMs: 50, // shorter than the spawner's 200ms wait
        historyTurns: 3,
      },
      attempt: makeAttempt({ assistantTexts: ["x"] }),
      iteration: 1,
      spawnReviewer,
      log,
    });
    expect(result).toBe("canned-default");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reviewer spawn failed"));
  });
});
