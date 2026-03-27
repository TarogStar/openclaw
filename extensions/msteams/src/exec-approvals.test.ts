import type { PluginHookExecApprovalRequestedEvent } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildExecApprovalCard,
  buildResolvedCard,
  getExecApprovalActionHandler,
  isExecApprovalAction,
  parseExecApprovalAction,
  registerMSTeamsExecApprovalHooks,
  setExecApprovalDeps,
} from "./exec-approvals.js";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function createFakeApi(configOverrides?: Record<string, unknown>) {
  const hooks: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  return {
    config: {
      channels: {
        msteams: {
          execApprovals: { enabled: true },
          ...configOverrides,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    resolveExecApproval: vi.fn(async () => {}),
    on(event: string, handler: (...args: unknown[]) => unknown) {
      hooks[event] ??= [];
      hooks[event].push(handler);
    },
    async fire(event: string, ...args: unknown[]) {
      for (const handler of hooks[event] ?? []) {
        const result = await handler(...args);
        if (result) {
          return result;
        }
      }
      return undefined;
    },
    hooks,
  };
}

function makeRequestedEvent(
  overrides?: Partial<PluginHookExecApprovalRequestedEvent>,
): PluginHookExecApprovalRequestedEvent {
  return {
    id: "approval-1",
    command: "npm install",
    cwd: "/tmp/project",
    host: "workstation",
    agentId: "copilot",
    sessionKey: "agent:copilot:subagent:abc",
    security: null,
    ask: null,
    expiresAtMs: Date.now() + 120_000,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

function createFakeDeps() {
  const sentActivities: unknown[] = [];
  const adapter = {
    continueConversation: vi.fn(
      async (_appId: string, _ref: unknown, callback: (ctx: unknown) => Promise<void>) => {
        const ctx = {
          sendActivity: vi.fn(async (activity: unknown) => {
            sentActivities.push(activity);
          }),
        };
        await callback(ctx);
      },
    ),
  };
  const conversationStore = {
    upsert: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    list: vi.fn(async () => [
      {
        conversationId: "conv-1",
        reference: {
          user: { id: "user-1", name: "Test User" },
          agent: { id: "bot-1", name: "Bot" },
          conversation: { id: "conv-1", tenantId: "tenant-1" },
          serviceUrl: "https://smba.trafficmanager.net/teams/",
          channelId: "msteams",
        },
      },
    ]),
    remove: vi.fn(async () => true),
    findByUserId: vi.fn(async () => null),
  };
  return { adapter, conversationStore, sentActivities, appId: "test-app-id" };
}

// -----------------------------------------------------------------------
// Action data helpers
// -----------------------------------------------------------------------

describe("isExecApprovalAction", () => {
  it("returns true for valid exec approval action data", () => {
    expect(
      isExecApprovalAction({
        openclawExecApproval: true,
        approvalId: "a1",
        action: "allow-once",
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isExecApprovalAction(null)).toBe(false);
  });

  it("returns false for non-approval objects", () => {
    expect(isExecApprovalAction({ foo: "bar" })).toBe(false);
  });

  it("returns false for string", () => {
    expect(isExecApprovalAction("string")).toBe(false);
  });
});

describe("parseExecApprovalAction", () => {
  it("parses valid allow-once action", () => {
    expect(
      parseExecApprovalAction({
        openclawExecApproval: true,
        approvalId: "a1",
        action: "allow-once",
      }),
    ).toEqual({ approvalId: "a1", action: "allow-once" });
  });

  it("parses valid allow-always action", () => {
    expect(
      parseExecApprovalAction({
        openclawExecApproval: true,
        approvalId: "a1",
        action: "allow-always",
      }),
    ).toEqual({ approvalId: "a1", action: "allow-always" });
  });

  it("parses valid deny action", () => {
    expect(
      parseExecApprovalAction({
        openclawExecApproval: true,
        approvalId: "a1",
        action: "deny",
      }),
    ).toEqual({ approvalId: "a1", action: "deny" });
  });

  it("returns null for missing approvalId", () => {
    expect(parseExecApprovalAction({ action: "allow-once" })).toBeNull();
  });

  it("returns null for missing action", () => {
    expect(parseExecApprovalAction({ approvalId: "a1" })).toBeNull();
  });

  it("returns null for invalid action value", () => {
    expect(parseExecApprovalAction({ approvalId: "a1", action: "explode" })).toBeNull();
  });
});

// -----------------------------------------------------------------------
// Card builders
// -----------------------------------------------------------------------

describe("buildExecApprovalCard", () => {
  it("returns an AdaptiveCard with three submit actions", () => {
    const event = makeRequestedEvent();
    const card = buildExecApprovalCard(event);

    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.4");
    expect(Array.isArray(card.actions)).toBe(true);
    const actions = card.actions as Array<{ title: string; data: Record<string, unknown> }>;
    expect(actions).toHaveLength(3);
    expect(actions[0].title).toBe("Allow Once");
    expect(actions[1].title).toBe("Always Allow");
    expect(actions[2].title).toBe("Deny");
  });

  it("includes the command in the card body", () => {
    const event = makeRequestedEvent({ command: "echo hello" });
    const card = buildExecApprovalCard(event);
    const body = card.body as Array<{ text?: string }>;
    const commandBlock = body.find((b) => b.text?.includes("echo hello"));
    expect(commandBlock).toBeDefined();
  });

  it("truncates long commands", () => {
    const longCommand = "x".repeat(600);
    const event = makeRequestedEvent({ command: longCommand });
    const card = buildExecApprovalCard(event);
    const body = card.body as Array<{ text?: string }>;
    const commandBlock = body.find((b) => b.text?.includes("..."));
    expect(commandBlock).toBeDefined();
  });

  it("includes metadata when present", () => {
    const event = makeRequestedEvent({ cwd: "/home/user", agentId: "copilot", host: "box1" });
    const card = buildExecApprovalCard(event);
    const body = card.body as Array<{ text?: string }>;
    const metaBlock = body.find((b) => b.text?.includes("CWD"));
    expect(metaBlock).toBeDefined();
    expect(metaBlock!.text).toContain("copilot");
    expect(metaBlock!.text).toContain("box1");
  });

  it("action data contains approval key", () => {
    const event = makeRequestedEvent({ id: "test-id" });
    const card = buildExecApprovalCard(event);
    const actions = card.actions as Array<{ data: Record<string, unknown> }>;
    expect(actions[0].data.openclawExecApproval).toBe(true);
    expect(actions[0].data.approvalId).toBe("test-id");
    expect(actions[0].data.action).toBe("allow-once");
  });
});

describe("buildResolvedCard", () => {
  it("shows Allowed (once) for allow-once decision", () => {
    const event = makeRequestedEvent();
    const card = buildResolvedCard(event, "allow-once", "Test User");
    const body = card.body as Array<{ text?: string; color?: string }>;
    expect(body[0].text).toContain("Allowed (once)");
    expect(body[0].color).toBe("Good");
  });

  it("shows Denied for deny decision", () => {
    const event = makeRequestedEvent();
    const card = buildResolvedCard(event, "deny");
    const body = card.body as Array<{ text?: string; color?: string }>;
    expect(body[0].text).toContain("Denied");
    expect(body[0].color).toBe("Attention");
  });

  it("includes resolvedBy when provided", () => {
    const event = makeRequestedEvent();
    const card = buildResolvedCard(event, "allow-always", "Jane");
    const body = card.body as Array<{ text?: string }>;
    const resolvedBlock = body.find((b) => b.text?.includes("Jane"));
    expect(resolvedBlock).toBeDefined();
  });

  it("says Resolved when no resolvedBy", () => {
    const event = makeRequestedEvent();
    const card = buildResolvedCard(event, "allow-once");
    const body = card.body as Array<{ text?: string }>;
    const resolvedBlock = body.find((b) => b.text === "Resolved");
    expect(resolvedBlock).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// Hook registration & card action handler
// -----------------------------------------------------------------------

describe("registerMSTeamsExecApprovalHooks", () => {
  it("registers exec_approval_requested and exec_approval_resolved hooks", () => {
    const api = createFakeApi();
    registerMSTeamsExecApprovalHooks(api as never);

    expect(api.hooks.exec_approval_requested).toHaveLength(1);
    expect(api.hooks.exec_approval_resolved).toHaveLength(1);
  });

  it("sends adaptive card when approval is requested and deps are available", async () => {
    const api = createFakeApi();
    const deps = createFakeDeps();
    registerMSTeamsExecApprovalHooks(api as never);
    setExecApprovalDeps({
      adapter: deps.adapter as never,
      appId: deps.appId,
      conversationStore: deps.conversationStore as never,
    });

    await api.fire("exec_approval_requested", makeRequestedEvent());

    expect(deps.adapter.continueConversation).toHaveBeenCalledTimes(1);
    expect(deps.sentActivities).toHaveLength(1);
    const activity = deps.sentActivities[0] as { attachments?: Array<{ contentType: string }> };
    expect(activity.attachments?.[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
  });

  it("skips when execApprovals is disabled", async () => {
    const api = createFakeApi({ execApprovals: { enabled: false } });
    const deps = createFakeDeps();
    registerMSTeamsExecApprovalHooks(api as never);
    setExecApprovalDeps({
      adapter: deps.adapter as never,
      appId: deps.appId,
      conversationStore: deps.conversationStore as never,
    });

    await api.fire("exec_approval_requested", makeRequestedEvent());

    expect(deps.adapter.continueConversation).not.toHaveBeenCalled();
  });

  it("skips when deps are not yet available", async () => {
    // Reset deps
    (globalThis as Record<string, unknown>).__openclaw_msteams_exec_approval_deps = undefined;

    const api = createFakeApi();
    registerMSTeamsExecApprovalHooks(api as never);

    // Should not throw
    await api.fire("exec_approval_requested", makeRequestedEvent());
    expect(api.logger.debug).toHaveBeenCalled();
  });

  it("skips when no conversations in store", async () => {
    const api = createFakeApi();
    const deps = createFakeDeps();
    deps.conversationStore.list.mockResolvedValue([]);
    registerMSTeamsExecApprovalHooks(api as never);
    setExecApprovalDeps({
      adapter: deps.adapter as never,
      appId: deps.appId,
      conversationStore: deps.conversationStore as never,
    });

    await api.fire("exec_approval_requested", makeRequestedEvent());

    expect(deps.adapter.continueConversation).not.toHaveBeenCalled();
  });

  it("global action handler resolves approvals via api", async () => {
    const api = createFakeApi();
    const deps = createFakeDeps();
    registerMSTeamsExecApprovalHooks(api as never);
    setExecApprovalDeps({
      adapter: deps.adapter as never,
      appId: deps.appId,
      conversationStore: deps.conversationStore as never,
    });

    const handler = getExecApprovalActionHandler();
    expect(handler).not.toBeNull();

    const result = await handler!({
      openclawExecApproval: true,
      approvalId: "test-123",
      action: "allow-once",
    });

    expect(result).toBe(true);
    expect(api.resolveExecApproval).toHaveBeenCalledWith("test-123", "allow-once");
  });

  it("global action handler returns false for non-approval data", async () => {
    const api = createFakeApi();
    registerMSTeamsExecApprovalHooks(api as never);

    const handler = getExecApprovalActionHandler();
    const result = await handler!({ foo: "bar" });

    expect(result).toBe(false);
  });

  it("global action handler returns false for invalid approval data", async () => {
    const api = createFakeApi();
    registerMSTeamsExecApprovalHooks(api as never);

    const handler = getExecApprovalActionHandler();
    const result = await handler!({
      openclawExecApproval: true,
      approvalId: "",
      action: "allow-once",
    });

    expect(result).toBe(false);
  });
});
