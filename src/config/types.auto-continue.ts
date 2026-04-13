/**
 * Auto-continue: injects a synthetic user prompt between attempts when the
 * model ends a turn without emitting a tool call, until a terminal signal or
 * iteration cap halts the loop.
 *
 * Designed for autonomous pipelines (PM orchestrator, heartbeat) where the
 * model should keep advancing rather than waiting on a user message it will
 * never receive.
 *
 * Off by default. Opt in per-agent or via agents.defaults.
 */
export type AutoContinueConfig = {
  /** Enable auto-continue (default: false). */
  enabled?: boolean;
  /**
   * Max synthetic continuations per run before halting. Default: 20.
   * Counter resets when a real user message arrives (new run).
   */
  maxIterations?: number;
  /**
   * Prompt injected as a synthetic user message when no tool call was emitted.
   * Default: "Use your best judgement and continue."
   */
  prompt?: string;
  /**
   * Terminal signals the model can emit in its assistant text to halt
   * auto-continue cleanly. Matched as case-sensitive substrings.
   * Default: ["PIPELINE_IDLE", "BLOCKED", "CYCLE_RESET", "TASK_COMPLETE", "AWAITING_HUMAN"].
   */
  stopOnSignals?: string[];
  /**
   * If set, stop auto-continuing when any of these tool names was called in
   * the last attempt. Typical use: a "send final reply" tool that marks the
   * end of work.
   */
  stopOnToolCall?: string[];
  /**
   * Delay between auto-continues in milliseconds. Default: 0.
   * Useful for throttling local-model-heavy pipelines to avoid thrashing.
   */
  cooldownMs?: number;
  /**
   * When true, auto-continue fires even if the assistant produced no text.
   * Default: false (safer — empty output usually means a crash or dead turn).
   */
  continueOnEmpty?: boolean;
};
