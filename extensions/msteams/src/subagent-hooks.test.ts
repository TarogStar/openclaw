import { describe, expect, it, vi } from "vitest";
import { registerMSTeamsSubagentHooks } from "./subagent-hooks.js";

function createFakeApi() {
  const hooks: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  return {
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

describe("registerMSTeamsSubagentHooks", () => {
  it("registers subagent_spawning, subagent_ended, and subagent_delivery_target hooks", () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    expect(api.hooks.subagent_spawning).toHaveLength(1);
    expect(api.hooks.subagent_ended).toHaveLength(1);
    expect(api.hooks.subagent_delivery_target).toHaveLength(1);
  });

  it("ignores non-msteams channels in subagent_spawning", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    const result = await api.fire("subagent_spawning", {
      threadRequested: true,
      requester: { channel: "discord" },
      childSessionKey: "test-session",
    });
    expect(result).toBeUndefined();
  });

  it("ignores when threadRequested is false", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    const result = await api.fire("subagent_spawning", {
      threadRequested: false,
      requester: { channel: "msteams" },
      childSessionKey: "test-session",
    });
    expect(result).toBeUndefined();
  });

  it("accepts msteams subagent spawn with threadBindingReady", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    const result = await api.fire("subagent_spawning", {
      threadRequested: true,
      requester: {
        channel: "msteams",
        accountId: "acc1",
        to: "user:123",
        threadId: "activity-456",
      },
      childSessionKey: "agent:copilot:subagent:abc",
      agentId: "copilot",
    });
    expect(result).toEqual({ status: "ok", threadBindingReady: true });
  });

  it("returns delivery target for bound msteams subagent", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    // First bind
    await api.fire("subagent_spawning", {
      threadRequested: true,
      requester: {
        channel: "msteams",
        accountId: "acc1",
        to: "user:123",
        threadId: "activity-456",
      },
      childSessionKey: "agent:copilot:subagent:abc",
      agentId: "copilot",
    });

    // Then resolve delivery target
    const target = await api.fire("subagent_delivery_target", {
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "msteams", accountId: "acc1" },
      childSessionKey: "agent:copilot:subagent:abc",
    });
    expect(target).toEqual({
      origin: {
        channel: "msteams",
        accountId: "acc1",
        to: "user:123",
        threadId: "activity-456",
      },
    });
  });

  it("returns nothing for non-msteams delivery target", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    const target = await api.fire("subagent_delivery_target", {
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "discord" },
      childSessionKey: "agent:copilot:subagent:abc",
    });
    expect(target).toBeUndefined();
  });

  it("cleans up binding on subagent_ended", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    // Bind
    await api.fire("subagent_spawning", {
      threadRequested: true,
      requester: { channel: "msteams", accountId: "acc1", to: "user:123" },
      childSessionKey: "agent:copilot:subagent:xyz",
      agentId: "copilot",
    });

    // End subagent
    await api.fire("subagent_ended", {
      targetSessionKey: "agent:copilot:subagent:xyz",
      targetKind: "subagent",
      reason: "completed",
    });

    // Delivery target should return nothing
    const target = await api.fire("subagent_delivery_target", {
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "msteams" },
      childSessionKey: "agent:copilot:subagent:xyz",
    });
    expect(target).toBeUndefined();
  });

  it("ignores delivery target when expectsCompletionMessage is false", async () => {
    const api = createFakeApi();
    registerMSTeamsSubagentHooks(api as never);

    await api.fire("subagent_spawning", {
      threadRequested: true,
      requester: { channel: "msteams", accountId: "acc1", to: "user:123" },
      childSessionKey: "agent:copilot:subagent:abc",
      agentId: "copilot",
    });

    const target = await api.fire("subagent_delivery_target", {
      expectsCompletionMessage: false,
      requesterOrigin: { channel: "msteams" },
      childSessionKey: "agent:copilot:subagent:abc",
    });
    expect(target).toBeUndefined();
  });
});
