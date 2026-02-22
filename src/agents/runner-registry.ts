import type { AgentStreamParams } from "../commands/agent/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

export type PluginAgentRunnerParams = {
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  prompt: string;
  timeoutMs: number;
  runId: string;
  streamParams?: AgentStreamParams;
};

export type PluginAgentRunnerFn = (params: PluginAgentRunnerParams) => Promise<EmbeddedPiRunResult>;

const runners = new Map<string, PluginAgentRunnerFn>();

export function registerPluginAgentRunner(providerId: string, runner: PluginAgentRunnerFn): void {
  runners.set(providerId, runner);
}

export function getPluginAgentRunner(providerId: string): PluginAgentRunnerFn | null {
  return runners.get(providerId) ?? null;
}
