import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotStudioAuth } from "./auth.js";
import { CopilotStudioClient } from "./client.js";

// Stub auth that returns a fixed token
function stubAuth(token = "test-token"): CopilotStudioAuth {
  return { getToken: vi.fn().mockResolvedValue(token) } as unknown as CopilotStudioAuth;
}

/** Build an SSE Response from a list of JSON activity objects. */
function sseResponse(
  activities: Record<string, unknown>[],
  headers?: Record<string, string>,
): Response {
  const lines = activities.map((a) => `data: ${JSON.stringify(a)}\n\n`).join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-ms-conversationid": "conv-123",
      ...headers,
    },
  });
}

/** Empty SSE response (just drainable body). */
function emptySseResponse(conversationId = "conv-123"): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-ms-conversationid": conversationId,
    },
  });
}

function createClient(auth?: CopilotStudioAuth) {
  return new CopilotStudioClient(
    { directConnectUrl: "https://example.com/api/conversations?api-version=2024" },
    auth ?? stubAuth(),
    () => {},
  );
}

describe("CopilotStudioClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("query", () => {
    it("starts a conversation then sends a message", async () => {
      // First fetch: startConversation
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      // Second fetch: sendMessage
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "Hello world" }]));

      const client = createClient();
      const result = await client.query("test message");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.text).toBe("Hello world");
      expect(result.conversationId).toBe("conv-123");
    });

    it("passes auth token in Authorization header", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "ok" }]));

      const client = createClient(stubAuth("my-bearer-token"));
      await client.query("hi");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-bearer-token");
    });
  });

  describe("startConversation", () => {
    it("extracts conversation ID from x-ms-conversationid header", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse("my-conv-id"));
      mockFetch.mockResolvedValueOnce(
        sseResponse([{ type: "message", text: "ok" }], {
          "x-ms-conversationid": "my-conv-id",
        }),
      );

      const client = createClient();
      const result = await client.query("hi");
      expect(result.conversationId).toBe("my-conv-id");
    });

    it("throws when conversation ID header is missing", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200, headers: {} }));

      const client = createClient();
      await expect(client.query("hi")).rejects.toThrow(
        "No conversation ID in x-ms-conversationid header",
      );
    });

    it("throws on HTTP error with status code", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
      );

      const client = createClient();
      await expect(client.query("hi")).rejects.toThrow("Start conversation failed (401)");
    });
  });

  describe("sendMessage", () => {
    it("sends activity with correct structure", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "reply" }]));

      const client = createClient();
      await client.query("my question");

      const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.activity.type).toBe("message");
      expect(body.activity.text).toBe("my question");
      expect(body.activity.conversation.id).toBe("conv-123");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400, statusText: "Bad Request" }),
      );

      const client = createClient();
      await expect(client.query("hi")).rejects.toThrow("Copilot Studio API error (400)");
    });

    it("throws on empty response", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      // Response with no activities, no text, no cards
      const emptyBody = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(emptyBody, {
          status: 200,
          headers: { "x-ms-conversationid": "conv-123" },
        }),
      );

      const client = createClient();
      await expect(client.query("hi")).rejects.toThrow("empty response");
    });
  });

  describe("continueConversation", () => {
    it("sends to existing conversation ID", async () => {
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "continued" }]));

      const client = createClient();
      const result = await client.continueConversation("existing-conv", "follow up");

      expect(result.text).toBe("continued");
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/conversations/existing-conv");
    });

    it("sends activityValue with empty text for consent responses", async () => {
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "approved" }]));

      const client = createClient();
      await client.continueConversation("conv-1", "original prompt", undefined, {
        action: "allow",
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.activity.text).toBe("");
      expect(body.activity.value).toEqual({ action: "allow" });
    });
  });

  describe("SSE activity parsing", () => {
    it("collects final message text", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        sseResponse([
          {
            type: "message",
            text: "Final answer",
            entities: [{ type: "streaminfo", streamType: "final" }],
            channelData: { streamId: "s1" },
          },
        ]),
      );

      const client = createClient();
      const result = await client.query("q");
      expect(result.text).toBe("Final answer");
    });

    it("prefers final message over streaming chunks", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        sseResponse([
          {
            type: "message",
            text: "partial",
            channelData: { streamType: "streaming", streamId: "s1" },
          },
          {
            type: "message",
            text: "Complete answer here",
            entities: [{ type: "streaminfo", streamType: "final" }],
            channelData: { streamId: "s1" },
          },
        ]),
      );

      const client = createClient();
      const result = await client.query("q");
      expect(result.text).toBe("Complete answer here");
    });

    it("extracts adaptive cards from attachments", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        sseResponse([
          {
            type: "message",
            text: "",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: { body: [{ type: "TextBlock", text: "Allow?" }] },
                name: "consent",
              },
            ],
          },
        ]),
      );

      const client = createClient();
      const result = await client.query("q");
      expect(result.adaptiveCards).toHaveLength(1);
      expect(result.adaptiveCards[0].name).toBe("consent");
      expect(result.adaptiveCards[0].content).toEqual({
        body: [{ type: "TextBlock", text: "Allow?" }],
      });
    });

    it("filters plain typing from activities but captures text as stream preview", async () => {
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        sseResponse([
          { type: "typing", text: "thinking...", channelData: { streamId: "s1" } },
          {
            type: "message",
            text: "Final answer",
            entities: [{ type: "streaminfo", streamType: "final" }],
            channelData: { streamId: "s1" },
          },
        ]),
      );

      const client = createClient();
      const result = await client.query("q");
      // Plain typing is filtered from activities array
      expect(result.activities.every((a) => a.type !== "typing")).toBe(true);
      // But the final message replaces the typing preview text
      expect(result.text).toBe("Final answer");
    });

    it("skips data: end markers", async () => {
      // Manually build SSE with end marker
      const lines = `data: ${JSON.stringify({ type: "message", text: "ok" })}\n\ndata: end\n\n`;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lines));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "x-ms-conversationid": "conv-123" },
        }),
      );

      const client = createClient();
      const result = await client.query("q");
      expect(result.text).toBe("ok");
      expect(result.activities).toHaveLength(1);
    });

    it("handles malformed JSON gracefully", async () => {
      const lines = `data: {invalid json}\n\ndata: ${JSON.stringify({ type: "message", text: "ok" })}\n\n`;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lines));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "x-ms-conversationid": "conv-123" },
        }),
      );

      const client = createClient();
      const result = await client.query("q");
      // Malformed JSON is skipped, valid activity collected
      expect(result.text).toBe("ok");
    });
  });

  describe("URL construction", () => {
    it("strips existing /conversations path from directConnectUrl", async () => {
      const client = new CopilotStudioClient(
        { directConnectUrl: "https://example.com/api/conversations?api-version=2024" },
        stubAuth(),
        () => {},
      );

      mockFetch.mockResolvedValueOnce(emptySseResponse());
      mockFetch.mockResolvedValueOnce(sseResponse([{ type: "message", text: "ok" }]));

      await client.query("hi");

      const [startUrl] = mockFetch.mock.calls[0] as [string];
      // Should have /api/conversations (not /api/conversations/conversations)
      expect(startUrl).toMatch(/\/api\/conversations\?/);
      expect(startUrl).not.toContain("/conversations/conversations");
    });
  });
});
