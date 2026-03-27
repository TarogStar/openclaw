import type {
  OpenClawPluginApi,
  PluginHookExecApprovalRequestedEvent,
  PluginHookExecApprovalResolvedEvent,
} from "openclaw/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { buildConversationReference, type MSTeamsAdapter } from "./messenger.js";

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

type PendingApproval = {
  event: PluginHookExecApprovalRequestedEvent;
  timeoutId: NodeJS.Timeout | null;
};

const EXEC_APPROVAL_ACTION_KEY = "openclawExecApproval";

// -----------------------------------------------------------------------
// Lazy deps – set by monitor.ts once adapter/store are available
// -----------------------------------------------------------------------

type ExecApprovalDeps = {
  adapter: MSTeamsAdapter;
  appId: string;
  conversationStore: MSTeamsConversationStore;
};

const DEPS_KEY = "__openclaw_msteams_exec_approval_deps";

export function setExecApprovalDeps(deps: ExecApprovalDeps): void {
  (globalThis as Record<string, unknown>)[DEPS_KEY] = deps;
}

function getExecApprovalDeps(): ExecApprovalDeps | null {
  return ((globalThis as Record<string, unknown>)[DEPS_KEY] as ExecApprovalDeps) ?? null;
}

// -----------------------------------------------------------------------
// Global accessor for handling card actions from monitor-handler
// -----------------------------------------------------------------------

type ExecApprovalActionHandler = (actionData: Record<string, unknown>) => Promise<boolean>;

const HANDLER_KEY = "__openclaw_msteams_exec_approval_handler";

export function setExecApprovalActionHandler(handler: ExecApprovalActionHandler): void {
  (globalThis as Record<string, unknown>)[HANDLER_KEY] = handler;
}

export function getExecApprovalActionHandler(): ExecApprovalActionHandler | null {
  return (
    ((globalThis as Record<string, unknown>)[HANDLER_KEY] as ExecApprovalActionHandler) ?? null
  );
}

// -----------------------------------------------------------------------
// Action data helpers
// -----------------------------------------------------------------------

export function isExecApprovalAction(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[EXEC_APPROVAL_ACTION_KEY] === true
  );
}

export function parseExecApprovalAction(
  value: Record<string, unknown>,
): { approvalId: string; action: ExecApprovalDecision } | null {
  const approvalId = typeof value.approvalId === "string" ? value.approvalId.trim() : "";
  const action = typeof value.action === "string" ? value.action.trim() : "";
  if (!approvalId || !action) {
    return null;
  }
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") {
    return null;
  }
  return { approvalId, action };
}

// -----------------------------------------------------------------------
// Adaptive Card builders
// -----------------------------------------------------------------------

function formatCommandPreview(command: string, maxChars = 500): string {
  return command.length > maxChars ? `${command.slice(0, maxChars)}...` : command;
}

export function buildExecApprovalCard(
  event: PluginHookExecApprovalRequestedEvent,
): Record<string, unknown> {
  const commandPreview = formatCommandPreview(event.command);
  const expiresInSeconds = Math.max(0, Math.round((event.expiresAtMs - Date.now()) / 1000));

  const metadataItems: string[] = [];
  if (event.cwd) {
    metadataItems.push(`**CWD:** ${event.cwd}`);
  }
  if (event.agentId) {
    metadataItems.push(`**Agent:** ${event.agentId}`);
  }
  if (event.host) {
    metadataItems.push(`**Host:** ${event.host}`);
  }

  const body: unknown[] = [
    {
      type: "TextBlock",
      text: "Command Approval Required",
      weight: "Bolder",
      size: "Medium",
      color: "Warning",
    },
    {
      type: "TextBlock",
      text: "A command needs your approval before it can execute.",
      wrap: true,
      spacing: "Small",
    },
    {
      type: "TextBlock",
      text: `\`\`\`\n${commandPreview}\n\`\`\``,
      wrap: true,
      fontType: "Monospace",
      spacing: "Medium",
    },
  ];

  if (metadataItems.length > 0) {
    body.push({
      type: "TextBlock",
      text: metadataItems.join("  |  "),
      wrap: true,
      size: "Small",
      isSubtle: true,
    });
  }

  body.push({
    type: "TextBlock",
    text: `Expires in ${expiresInSeconds}s  |  ID: ${event.id}`,
    size: "Small",
    isSubtle: true,
    spacing: "Small",
  });

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Allow Once",
        style: "positive",
        data: {
          [EXEC_APPROVAL_ACTION_KEY]: true,
          approvalId: event.id,
          action: "allow-once",
        },
      },
      {
        type: "Action.Submit",
        title: "Always Allow",
        data: {
          [EXEC_APPROVAL_ACTION_KEY]: true,
          approvalId: event.id,
          action: "allow-always",
        },
      },
      {
        type: "Action.Submit",
        title: "Deny",
        style: "destructive",
        data: {
          [EXEC_APPROVAL_ACTION_KEY]: true,
          approvalId: event.id,
          action: "deny",
        },
      },
    ],
  };
}

export function buildResolvedCard(
  event: PluginHookExecApprovalRequestedEvent,
  decision: ExecApprovalDecision,
  resolvedBy?: string | null,
): Record<string, unknown> {
  const commandPreview = formatCommandPreview(event.command, 200);
  const decisionLabel =
    decision === "allow-once"
      ? "Allowed (once)"
      : decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const color = decision === "deny" ? "Attention" : "Good";

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `Command ${decisionLabel}`,
        weight: "Bolder",
        size: "Medium",
        color,
      },
      {
        type: "TextBlock",
        text: `\`\`\`\n${commandPreview}\n\`\`\``,
        wrap: true,
        fontType: "Monospace",
        spacing: "Small",
      },
      {
        type: "TextBlock",
        text: resolvedBy ? `Resolved by ${resolvedBy}` : "Resolved",
        size: "Small",
        isSubtle: true,
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Hook registration
// -----------------------------------------------------------------------

export function registerMSTeamsExecApprovalHooks(api: OpenClawPluginApi): void {
  const pending = new Map<string, PendingApproval>();
  const log = api.logger;

  api.on("exec_approval_requested", async (event) => {
    const msteamsCfg = api.config.channels?.msteams;
    if (!msteamsCfg?.execApprovals?.enabled) {
      return;
    }

    const deps = getExecApprovalDeps();
    if (!deps) {
      log.debug?.("exec approval: deps not yet available (monitor not started)");
      return;
    }

    // Resolve the conversation to send the card to.
    const conversationRef = await resolveConversationRefFromStore(deps.conversationStore);
    if (!conversationRef) {
      log.debug?.("exec approval: no conversation reference found");
      return;
    }

    const card = buildExecApprovalCard(event);

    try {
      const ref = buildConversationReference(conversationRef);
      await deps.adapter.continueConversation(deps.appId, ref, async (ctx) => {
        await ctx.sendActivity({
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
      });

      // Track pending approval for timeout/resolution
      const expiresInMs = Math.max(0, event.expiresAtMs - Date.now());
      const timeoutId = setTimeout(() => {
        pending.delete(event.id);
      }, expiresInMs);
      timeoutId.unref?.();

      pending.set(event.id, { event, timeoutId });
      log.debug?.(`exec approval: sent card for ${event.id}`);
    } catch (err) {
      log.error?.(`exec approval: failed to send card: ${String(err)}`);
    }
  });

  api.on("exec_approval_resolved", async (event) => {
    const entry = pending.get(event.id);
    if (!entry) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    pending.delete(event.id);
    log.debug?.(`exec approval: resolved ${event.id} -> ${event.decision}`);
  });

  // Register global handler so monitor-handler can route card actions
  setExecApprovalActionHandler(async (actionData) => {
    if (!isExecApprovalAction(actionData)) {
      return false;
    }
    const parsed = parseExecApprovalAction(actionData);
    if (!parsed) {
      return false;
    }
    try {
      await api.resolveExecApproval(parsed.approvalId, parsed.action);
      log.debug?.(
        `exec approval: resolved ${parsed.approvalId} via card action -> ${parsed.action}`,
      );
      return true;
    } catch (err) {
      log.error?.(`exec approval: failed to resolve via card action: ${String(err)}`);
      return false;
    }
  });
}

// -----------------------------------------------------------------------
// Informational card for exec denials / unavailable
// -----------------------------------------------------------------------

function buildExecDeniedCard(error: string): Record<string, unknown> {
  // Extract just the first line (main message) for the title area
  const lines = error.split("\n").filter(Boolean);
  const title = lines[0] ?? "Command Execution Blocked";
  const details = lines.slice(1).join("\n");

  const body: unknown[] = [
    {
      type: "TextBlock",
      text: "Command Execution Blocked",
      weight: "Bolder",
      size: "Medium",
      color: "Attention",
    },
    {
      type: "TextBlock",
      text: title,
      wrap: true,
      spacing: "Small",
    },
  ];

  if (details) {
    body.push({
      type: "TextBlock",
      text: `\`\`\`\n${details}\n\`\`\``,
      wrap: true,
      fontType: "Monospace",
      size: "Small",
      spacing: "Medium",
    });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
}

export function registerMSTeamsExecDeniedHandler(api: OpenClawPluginApi): void {
  const log = api.logger;

  api.on("after_tool_call", async (event) => {
    if (event.toolName !== "exec" || !event.error) {
      return;
    }

    const msteamsCfg = api.config.channels?.msteams;
    if (!msteamsCfg?.execApprovals?.enabled) {
      return;
    }

    const deps = getExecApprovalDeps();
    if (!deps) {
      return;
    }

    const conversationRef = await resolveConversationRefFromStore(deps.conversationStore);
    if (!conversationRef) {
      return;
    }

    const card = buildExecDeniedCard(event.error);

    try {
      const ref = buildConversationReference(conversationRef);
      await deps.adapter.continueConversation(deps.appId, ref, async (ctx) => {
        await ctx.sendActivity({
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
      });
      log.debug?.("exec denied: sent informational card");
    } catch (err) {
      log.error?.(`exec denied: failed to send card: ${String(err)}`);
    }
  });
}

// -----------------------------------------------------------------------
// Conversation store helper
// -----------------------------------------------------------------------

/**
 * Fallback: get the most recently active conversation reference.
 */
async function resolveConversationRefFromStore(
  store: MSTeamsConversationStore,
): Promise<Awaited<ReturnType<MSTeamsConversationStore["get"]>> | null> {
  try {
    const all = await store.list();
    if (all.length === 0) {
      return null;
    }
    return all[0]?.reference ?? null;
  } catch {
    return null;
  }
}
