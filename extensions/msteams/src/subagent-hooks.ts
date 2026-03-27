import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type MSTeamsSubagentBinding = {
  childSessionKey: string;
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  boundAt: number;
};

const bindingsBySessionKey = new Map<string, MSTeamsSubagentBinding>();

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

export function registerMSTeamsSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "msteams") {
      // Ignore non-MSTeams channels so other channel plugins can handle their own.
      return;
    }

    try {
      // Store a binding so we can route delivery back to the Teams conversation.
      // Unlike Discord, MSTeams doesn't require creating a new thread — the subagent
      // replies land in the same conversation (using replyToId for thread replies).
      const binding: MSTeamsSubagentBinding = {
        childSessionKey: event.childSessionKey,
        channel: "msteams",
        accountId: event.requester?.accountId,
        to: event.requester?.to,
        threadId: event.requester?.threadId,
        boundAt: Date.now(),
      };
      bindingsBySessionKey.set(event.childSessionKey, binding);

      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `MSTeams subagent bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", (event) => {
    bindingsBySessionKey.delete(event.targetSessionKey);
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "msteams") {
      return;
    }

    const binding = bindingsBySessionKey.get(event.childSessionKey);
    if (!binding) {
      return;
    }

    return {
      origin: {
        channel: "msteams",
        accountId: binding.accountId,
        to: binding.to,
        threadId: binding.threadId,
      },
    };
  });
}
