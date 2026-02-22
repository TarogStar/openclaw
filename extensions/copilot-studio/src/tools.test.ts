import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient, QueryResult } from "./client.js";
import {
  createCopilotCalendarTool,
  createCopilotEmailTool,
  createCopilotWebSearchTool,
} from "./tools.js";

const CARDS_KEY = "__openclaw_pending_adaptive_cards";
const CONVERSATIONS_KEY = "__openclaw_copilot_pending_conversations";
const INVOKES_KEY = "__openclaw_copilot_pending_invokes";

function clearGlobalState() {
  const g = globalThis as Record<string, unknown>;
  g[CARDS_KEY] = undefined;
  g[CONVERSATIONS_KEY] = undefined;
  g[INVOKES_KEY] = undefined;
}

function makeResult(overrides?: Partial<QueryResult>): QueryResult {
  return {
    text: "test result",
    activities: [],
    adaptiveCards: [],
    conversationId: "conv-1",
    ...overrides,
  };
}

function mockClient(): CopilotStudioClient {
  return {
    query: vi.fn().mockResolvedValue(makeResult()),
    continueConversation: vi.fn().mockResolvedValue(makeResult()),
  } as unknown as CopilotStudioClient;
}

describe("web_search tool", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("calls query with search prompt", async () => {
    const client = mockClient();
    const tool = createCopilotWebSearchTool(client);

    await tool.execute("call-1", { query: "weather today" });

    expect(client.query).toHaveBeenCalledTimes(1);
    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("weather today");
  });

  it("returns result with query and provider metadata", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({ text: "It's sunny" }),
    );
    const tool = createCopilotWebSearchTool(client);

    const result = await tool.execute("call-1", { query: "weather" });

    const details = result.details as Record<string, unknown>;
    expect(details.query).toBe("weather");
    expect(details.provider).toBe("copilot-studio");
    expect(details.content).toBe("It's sunny");
  });

  it("returns error when query parameter is missing", async () => {
    const client = mockClient();
    const tool = createCopilotWebSearchTool(client);

    const result = await tool.execute("call-1", {});

    const details = result.details as Record<string, unknown>;
    expect(details.error).toBe("copilot_studio_error");
    expect(details.message).toContain("query");
  });
});

describe("email tool", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("builds read prompt", async () => {
    const client = mockClient();
    const tool = createCopilotEmailTool(client);

    await tool.execute("call-1", { action: "read" });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("recent emails");
  });

  it("builds read prompt with filter", async () => {
    const client = mockClient();
    const tool = createCopilotEmailTool(client);

    await tool.execute("call-1", { action: "read", query: "from John" });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("from John");
  });

  it("builds search prompt", async () => {
    const client = mockClient();
    const tool = createCopilotEmailTool(client);

    await tool.execute("call-1", { action: "search", query: "meeting notes" });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("meeting notes");
  });

  it("builds send prompt with to, subject, body", async () => {
    const client = mockClient();
    const tool = createCopilotEmailTool(client);

    await tool.execute("call-1", {
      action: "send",
      to: "alice@example.com",
      subject: "Hello",
      body: "Hi there",
    });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("alice@example.com");
    expect(prompt).toContain("Hello");
    expect(prompt).toContain("Hi there");
  });

  it("returns error for unknown action", async () => {
    const client = mockClient();
    const tool = createCopilotEmailTool(client);

    const result = await tool.execute("call-1", { action: "delete" });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toBe("invalid_action");
  });
});

describe("calendar tool", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("builds check prompt with default timeframe", async () => {
    const client = mockClient();
    const tool = createCopilotCalendarTool(client);

    await tool.execute("call-1", { action: "check" });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("next 24 hours");
  });

  it("builds check prompt with custom timeframe", async () => {
    const client = mockClient();
    const tool = createCopilotCalendarTool(client);

    await tool.execute("call-1", { action: "check", query: "this week" });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("this week");
  });

  it("builds create prompt with attendees", async () => {
    const client = mockClient();
    const tool = createCopilotCalendarTool(client);

    await tool.execute("call-1", {
      action: "create",
      title: "Standup",
      datetime: "tomorrow at 9am",
      duration: "15 minutes",
      attendees: "bob@example.com, alice@example.com",
    });

    const prompt = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("Standup");
    expect(prompt).toContain("tomorrow at 9am");
    expect(prompt).toContain("15 minutes");
    expect(prompt).toContain("bob@example.com, alice@example.com");
  });

  it("returns error for unknown action", async () => {
    const client = mockClient();
    const tool = createCopilotCalendarTool(client);

    const result = await tool.execute("call-1", { action: "delete" });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toBe("invalid_action");
  });
});

describe("consent card flow", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("enqueues adaptive cards and stores pending conversation", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({
        adaptiveCards: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { body: [] },
          },
        ],
      }),
    );

    const tool = createCopilotWebSearchTool(client);
    const result = await tool.execute("call-1", { query: "test" });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("consent_required");

    // Cards should be enqueued
    const g = globalThis as Record<string, unknown>;
    const cards = g[CARDS_KEY] as unknown[];
    expect(cards).toHaveLength(1);

    // Conversation should be stored for follow-up
    const convs = g[CONVERSATIONS_KEY] as Array<{ toolName: string }>;
    expect(convs).toHaveLength(1);
    expect(convs[0].toolName).toBe("copilot_web_search");
  });

  it("continues pending conversation on next call", async () => {
    const client = mockClient();

    // Set up a pending conversation (simulating previous consent card)
    const g = globalThis as Record<string, unknown>;
    g[CONVERSATIONS_KEY] = [
      { conversationId: "pending-conv", toolName: "copilot_email", timestamp: Date.now() },
    ];
    g[INVOKES_KEY] = [{ actionData: { action: "allow" }, timestamp: Date.now() }];

    // Mock continueConversation for the consent step
    (client.continueConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult({ text: "Email sent successfully", conversationId: "pending-conv" }),
    );

    const tool = createCopilotEmailTool(client);
    await tool.execute("call-1", { action: "read" });

    // Should have called continueConversation, not query
    expect(client.continueConversation).toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("returns auth URL and enqueues auth card on DeviceCodeRequiredError", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeviceCodeRequiredError({
        userCode: "ABC123",
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Go to URL",
      }),
    );

    const tool = createCopilotWebSearchTool(client);
    const result = await tool.execute("call-1", { query: "test" });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toBe("auth_required");
    expect(details.userCode).toBe("ABC123");
    expect(details.verificationUri).toBe("https://microsoft.com/devicelogin");

    // Auth card should be enqueued for direct delivery to user
    const g = globalThis as Record<string, unknown>;
    const cards = g[CARDS_KEY] as Array<{ cards: unknown[]; text: string }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("ABC123");
  });

  it("returns error message for general errors", async () => {
    const client = mockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network timeout"));

    const tool = createCopilotWebSearchTool(client);
    const result = await tool.execute("call-1", { query: "test" });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toBe("copilot_studio_error");
    expect(details.message).toContain("Network timeout");
  });
});

describe("result truncation", () => {
  afterEach(() => {
    clearGlobalState();
  });

  it("truncates text longer than 3000 chars", async () => {
    const client = mockClient();
    const longText = "x".repeat(4000);
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(makeResult({ text: longText }));

    const tool = createCopilotWebSearchTool(client);
    const result = await tool.execute("call-1", { query: "test" });

    const text = result.content[0].text;
    expect(text.length).toBeLessThan(4000);
    expect(text).toContain("...(truncated)");
  });
});
