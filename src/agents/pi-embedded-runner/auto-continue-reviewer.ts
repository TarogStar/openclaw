import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import type { ResolvedAutoContinueConfig } from "./auto-continue.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

/** Default supervisor prompt template. Operators can override per-config. */
export const DEFAULT_REVIEWER_PROMPT = `You are a pipeline supervisor. Your ONLY job is to review the main agent's last few turns and emit exactly ONE continuation directive for the main agent's next turn.

You MUST output EXACTLY ONE of these on the LAST line of your response:

  CONTINUE: <single-sentence instruction for next PM turn>
  VERIFY: <command or file path to check before continuing>
  BLOCK: <single-sentence reason the pipeline should stop>

Decision rules:
1. If main agent claims work that should exist on disk, emit VERIFY with a concrete path or command (e.g., "ls ~/repos/Curo/.../index.test.tsx").
2. If main agent narrates subagent success without quoting an artifact, emit VERIFY to cross-check.
3. If main agent retried the same step 3+ times without progress, emit BLOCK.
4. If main agent is cleanly waiting mid-process, emit CONTINUE with a terse next-step instruction.
5. If process rules contradict main agent behavior, emit CONTINUE with the correction.

Produce no preamble. The directive line is the entire useful output. Keep total output under 200 tokens.

---

Main agent's recent turns ({HISTORY_COUNT} most recent):

{HISTORY}

---

Pipeline process rules:

{PROCESS}

---

Auto-continue iteration {ITERATION} of {MAX}.`;

/** Hard cap on the process-file content included in the prompt. */
export const PROCESS_FILE_MAX_CHARS = 8000;

/** Default supervisor wall-time cap. */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 60_000;

/** Default number of recent assistant turns to include. */
export const DEFAULT_REVIEWER_HISTORY_TURNS = 5;

export type ReviewerDirective =
  | { kind: "continue"; body: string }
  | { kind: "verify"; body: string }
  | { kind: "block"; body: string };

/**
 * Parse the supervisor's response to extract its directive. Scans from the
 * LAST line backwards to be tolerant of supervisors that narrate before
 * landing on the directive line. Returns null when no directive is found.
 */
export function parseReviewerDirective(reviewerOutput: string): ReviewerDirective | null {
  if (!reviewerOutput) {
    return null;
  }
  const lines = reviewerOutput.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("CONTINUE:")) {
      const body = line.slice("CONTINUE:".length).trim();
      if (body) {
        return { kind: "continue", body };
      }
    } else if (line.startsWith("VERIFY:")) {
      const body = line.slice("VERIFY:".length).trim();
      if (body) {
        return { kind: "verify", body };
      }
    } else if (line.startsWith("BLOCK:")) {
      const body = line.slice("BLOCK:".length).trim();
      if (body) {
        return { kind: "block", body };
      }
    }
  }
  return null;
}

/**
 * Wrap the supervisor's directive body into a synthetic user prompt for the
 * main agent. The `[supervisor directive]` prefix makes the source explicit
 * so the main agent doesn't confuse it with a real human message.
 */
export function directiveToPmPrompt(directive: ReviewerDirective): string {
  if (directive.kind === "continue") {
    return `[supervisor directive] Continue: ${directive.body}`;
  }
  if (directive.kind === "verify") {
    return `[supervisor directive] Before continuing, verify the following and report findings in your response: ${directive.body}`;
  }
  // block
  return `[supervisor directive] Mark pipeline BLOCKED and explain: ${directive.body}\n\nOutput "BLOCKED: <reason>" on a single line.`;
}

/**
 * Extract the most-recent N main-agent assistant turns as plain text.
 * Prefers `assistantTexts` since it's already plain; falls back to
 * `messagesSnapshot` filtered to the assistant role when needed.
 */
export function extractRecentHistory(attempt: EmbeddedRunAttemptResult, turns: number): string {
  // assistantTexts is per-text-block; collapse the most recent `turns` worth.
  const texts = (attempt.assistantTexts ?? [])
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t.length > 0);
  if (texts.length > 0) {
    const recent = texts.slice(-turns);
    return recent
      .map((t, i) => `--- turn ${recent.length - i} ---\n${t}`)
      .toReversed()
      .join("\n\n");
  }
  // Fallback: read message snapshot.
  const msgs = (attempt.messagesSnapshot ?? [])
    .filter((m) => (m as { role?: string }).role === "assistant")
    .slice(-turns);
  if (msgs.length === 0) {
    return "(no recent assistant output)";
  }
  return msgs
    .map((m, i) => {
      const content = (m as { content?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((c) =>
            typeof c === "object" && c && "text" in c && typeof c.text === "string" ? c.text : "",
          )
          .join("\n");
      }
      return `--- turn ${msgs.length - i} ---\n${text.trim()}`;
    })
    .toReversed()
    .join("\n\n");
}

/**
 * Best-effort read of the configured process file. Truncates at
 * PROCESS_FILE_MAX_CHARS to keep supervisor input bounded. Returns empty
 * string when path is unset or the file cannot be read — the supervisor
 * still functions, just without process context.
 */
export async function readProcessFile(processPath: string | undefined): Promise<string> {
  if (!processPath) {
    return "";
  }
  try {
    const expanded = expandUserPath(processPath);
    const content = await fs.readFile(expanded, "utf8");
    if (content.length > PROCESS_FILE_MAX_CHARS) {
      return `${content.slice(0, PROCESS_FILE_MAX_CHARS)}\n...[truncated at ${PROCESS_FILE_MAX_CHARS} chars]`;
    }
    return content;
  } catch {
    return "";
  }
}

function expandUserPath(p: string): string {
  // Prefer the project's resolveUserPath helper when it accepts the format.
  // Fall back to manual ~ expansion otherwise.
  try {
    return resolveUserPath(p);
  } catch {
    if (p.startsWith("~/")) {
      return path.join(os.homedir(), p.slice(2));
    }
    if (p === "~") {
      return os.homedir();
    }
    return p;
  }
}

/**
 * Build the full reviewer input prompt by interpolating template placeholders
 * with concrete history, process context, and iteration info.
 */
export function buildReviewerInput(params: {
  template: string;
  history: string;
  process: string;
  iteration: number;
  maxIterations: number;
  historyCount: number;
}): string {
  return params.template
    .replace("{HISTORY}", params.history || "(no recent assistant output)")
    .replace("{HISTORY_COUNT}", String(params.historyCount))
    .replace("{PROCESS}", params.process || "(no process file configured)")
    .replace("{ITERATION}", String(params.iteration))
    .replace("{MAX}", String(params.maxIterations));
}

/**
 * Pure helper used by tests and run.ts. Given a supervisor's raw output,
 * returns the synthetic prompt to inject into the next attempt — or null
 * when the supervisor output cannot be parsed (caller falls back to canned).
 */
export function reviewerOutputToPmPrompt(reviewerOutput: string): string | null {
  const directive = parseReviewerDirective(reviewerOutput);
  if (!directive) {
    return null;
  }
  return directiveToPmPrompt(directive);
}

/**
 * Function signature for the injected supervisor spawner. Kept abstract so
 * tests can stub without touching subagent infrastructure.
 */
export type SpawnReviewerFn = (params: {
  agentId: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<string>;

/**
 * Resolve the synthetic prompt to inject into the next main attempt.
 * If the supervisor is configured AND a spawner is provided, runs the
 * supervisor and uses its directive. On any failure, falls back to the
 * configured canned prompt.
 */
export async function resolveAutoContinueSyntheticPrompt(params: {
  autoContinueCfg: ResolvedAutoContinueConfig;
  reviewerCfg: ResolvedReviewerConfig | null;
  attempt: EmbeddedRunAttemptResult;
  iteration: number;
  spawnReviewer: SpawnReviewerFn | null;
  log?: { warn: (msg: string) => void; info: (msg: string) => void };
}): Promise<string> {
  const { autoContinueCfg, reviewerCfg, attempt, iteration, spawnReviewer, log } = params;

  // No reviewer configured or no spawner provided → canned prompt.
  if (!reviewerCfg || !spawnReviewer) {
    return autoContinueCfg.prompt;
  }

  const history = extractRecentHistory(attempt, reviewerCfg.historyTurns);
  const processText = await readProcessFile(reviewerCfg.processPath);
  const reviewerInput = buildReviewerInput({
    template: reviewerCfg.template,
    history,
    process: processText,
    iteration,
    maxIterations: autoContinueCfg.maxIterations,
    historyCount: reviewerCfg.historyTurns,
  });

  const startedAt = Date.now();
  let reviewerOutput: string;
  try {
    reviewerOutput = await Promise.race([
      spawnReviewer({
        agentId: reviewerCfg.agentId,
        prompt: reviewerInput,
        timeoutMs: reviewerCfg.timeoutMs,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`reviewer timeout after ${reviewerCfg.timeoutMs}ms`)),
          reviewerCfg.timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    log?.warn(
      `[auto-continue] reviewer spawn failed in ${Date.now() - startedAt}ms (${String(err)}); falling back to canned prompt`,
    );
    return autoContinueCfg.prompt;
  }

  const directivePrompt = reviewerOutputToPmPrompt(reviewerOutput);
  if (!directivePrompt) {
    log?.warn(
      `[auto-continue] reviewer returned unparseable output (no CONTINUE/VERIFY/BLOCK directive); falling back to canned prompt`,
    );
    return autoContinueCfg.prompt;
  }
  log?.info(
    `[auto-continue] reviewer directive applied iteration=${iteration} agent=${reviewerCfg.agentId} dt=${Date.now() - startedAt}ms`,
  );
  return directivePrompt;
}

/** Supervisor-specific config slice with defaults filled in. */
export type ResolvedReviewerConfig = {
  agentId: string;
  template: string;
  processPath: string | undefined;
  timeoutMs: number;
  historyTurns: number;
};

/**
 * Extract supervisor config from auto-continue config. Returns null when
 * `reviewerAgentId` is unset (supervisor disabled).
 */
export function resolveReviewerConfig(
  autoContinueCfg: ResolvedAutoContinueConfig & {
    reviewerAgentId?: string;
    reviewerPrompt?: string;
    reviewerProcessPath?: string;
    reviewerTimeoutMs?: number;
    reviewerHistoryTurns?: number;
  },
): ResolvedReviewerConfig | null {
  if (!autoContinueCfg.reviewerAgentId) {
    return null;
  }
  return {
    agentId: autoContinueCfg.reviewerAgentId,
    template:
      typeof autoContinueCfg.reviewerPrompt === "string" &&
      autoContinueCfg.reviewerPrompt.trim().length > 0
        ? autoContinueCfg.reviewerPrompt
        : DEFAULT_REVIEWER_PROMPT,
    processPath: autoContinueCfg.reviewerProcessPath,
    timeoutMs:
      typeof autoContinueCfg.reviewerTimeoutMs === "number" && autoContinueCfg.reviewerTimeoutMs > 0
        ? Math.floor(autoContinueCfg.reviewerTimeoutMs)
        : DEFAULT_REVIEWER_TIMEOUT_MS,
    historyTurns:
      typeof autoContinueCfg.reviewerHistoryTurns === "number" &&
      autoContinueCfg.reviewerHistoryTurns > 0
        ? Math.floor(autoContinueCfg.reviewerHistoryTurns)
        : DEFAULT_REVIEWER_HISTORY_TURNS,
  };
}
