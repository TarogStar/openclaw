import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioAgentRunner } from "./agent-runner.js";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient, QueryResult } from "./client.js";

const CARDS_KEY = "__openclaw_pending_adaptive_cards";

function clearGlobalState() {
  const g = globalThis as Record<string, unknown>;
  g[CARDS_KEY] = undefined;
}

function makeResult(overrides?: Partial<QueryResult>): QueryResult {
  return {
    text: "Hello from Copilot Studio",
    activities: [],
    adaptiveCards: [],
    conversationId: "conv-123",
    ...overrides,
  };
}

function mockClient(): CopilotStudioClient {
  return {
    query: vi.fn().mockResolvedValue(makeResult()),
    continueConversation: vi.fn().mockResolvedValue(makeResult()),
  } as unknown as CopilotStudioClient;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    sessionId: "session-1",
    sessionKey: "key-1",
    agentId: "copilot",
    prompt: "Hello",
    timeoutMs: 30_000,
    runId: "run-1",
    ...overrides,
  };
}

describe("CopilotStudioAgentRunner", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("starts a new conversation on first message", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    const result = await runner.run(makeParams());

    expect(client.query).toHaveBeenCalledWith("Hello", 30_000);
    expect(client.continueConversation).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("Hello from Copilot Studio");
    expect(result.meta.agentMeta?.provider).toBe("copilot-studio");
    expect(result.meta.agentMeta?.model).toBe("default");
  });

  it("continues existing conversation on subsequent messages", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    // First message — starts new conversation
    await runner.run(makeParams({ prompt: "Hello" }));
    expect(client.query).toHaveBeenCalledTimes(1);

    // Second message — continues conversation
    (client.continueConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({ text: "Follow-up response" }),
    );
    const result = await runner.run(makeParams({ prompt: "Tell me more" }));

    expect(client.continueConversation).toHaveBeenCalledWith("conv-123", "Tell me more", 30_000);
    expect(result.payloads?.[0]?.text).toBe("Follow-up response");
  });

  it("starts new conversation when session expires", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    // First message
    await runner.run(makeParams());

    // Simulate time passing beyond TTL (30 min)
    const sessions = (runner as unknown as { sessions: Map<string, { lastActiveAt: number }> })
      .sessions;
    const session = sessions.get("key-1");
    if (session) {
      session.lastActiveAt = Date.now() - 31 * 60 * 1000;
    }

    // Next message should start new conversation
    await runner.run(makeParams({ prompt: "After timeout" }));

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.continueConversation).not.toHaveBeenCalled();
  });

  it("falls back to new conversation when continueConversation fails", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    // First message — starts conversation
    await runner.run(makeParams());

    // Second message — continueConversation fails
    (client.continueConversation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Conversation expired"),
    );
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({ text: "Fresh start", conversationId: "conv-new" }),
    );

    const result = await runner.run(makeParams({ prompt: "Retry" }));

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Fresh start");
  });

  it("handles DeviceCodeRequiredError with auth card", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeviceCodeRequiredError({
        userCode: "XYZ789",
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Go to URL",
      }),
    );
    const runner = new CopilotStudioAgentRunner(client, () => {});

    const result = await runner.run(makeParams());

    expect(result.payloads?.[0]?.text).toContain("XYZ789");
    expect(result.payloads?.[0]?.text).toContain("microsoft.com/devicelogin");

    // Auth card should be enqueued
    const g = globalThis as Record<string, unknown>;
    const cards = g[CARDS_KEY] as Array<{ cards: unknown[]; text: string }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("XYZ789");
  });

  it("propagates DeviceCodeRequiredError from continueConversation", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    // First message succeeds
    await runner.run(makeParams());

    // Second message — auth expired
    (client.continueConversation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeviceCodeRequiredError({
        userCode: "AUTH42",
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Re-auth needed",
      }),
    );

    const result = await runner.run(makeParams({ prompt: "After auth expiry" }));

    // Should NOT fall back to query — auth errors propagate
    expect(client.query).toHaveBeenCalledTimes(1); // Only the first call
    expect(result.payloads?.[0]?.text).toContain("AUTH42");
  });

  it("returns error payload for general errors", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network timeout"));
    const runner = new CopilotStudioAgentRunner(client, () => {});

    const result = await runner.run(makeParams());

    expect(result.payloads?.[0]?.text).toContain("Network timeout");
    expect((result.payloads?.[0] as { isError?: boolean })?.isError).toBe(true);
  });

  it("enqueues adaptive cards from response", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({
        text: "Here are your results",
        adaptiveCards: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { body: [{ type: "TextBlock", text: "Card content" }] },
          },
        ],
      }),
    );
    const runner = new CopilotStudioAgentRunner(client, () => {});

    await runner.run(makeParams());

    const g = globalThis as Record<string, unknown>;
    const cards = g[CARDS_KEY] as Array<{ cards: unknown[] }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].cards).toHaveLength(1);
  });

  it("resetConversation clears session state", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    // Start a conversation
    await runner.run(makeParams());
    expect(client.query).toHaveBeenCalledTimes(1);

    // Reset
    runner.resetConversation("key-1");

    // Next message should start new conversation (not continue)
    await runner.run(makeParams({ prompt: "After reset" }));
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.continueConversation).not.toHaveBeenCalled();
  });

  it("uses sessionId as fallback when sessionKey is undefined", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    await runner.run(makeParams({ sessionKey: undefined }));
    expect(client.query).toHaveBeenCalledTimes(1);

    // Second call with same sessionId should continue
    (client.continueConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({ text: "Continued" }),
    );
    const result = await runner.run(makeParams({ sessionKey: undefined }));

    expect(client.continueConversation).toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("Continued");
  });

  it("includes durationMs in meta", async () => {
    const client = mockClient();
    const runner = new CopilotStudioAgentRunner(client, () => {});

    const result = await runner.run(makeParams());

    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
