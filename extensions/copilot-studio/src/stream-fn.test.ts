import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createCopilotStudioStreamFn, resetCopilotStudioConversation } from "./stream-fn.js";

// Minimal mock for CopilotStudioClient
function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({
      text: "Hello from Copilot Studio",
      activities: [],
      adaptiveCards: [],
      conversationId: "conv-123",
    }),
    continueConversation: vi.fn().mockResolvedValue({
      text: "Continued response",
      activities: [],
      adaptiveCards: [],
      conversationId: "conv-123",
    }),
    sendActivity: vi.fn().mockResolvedValue({
      text: "Activity response",
      activities: [],
      adaptiveCards: [],
      conversationId: "conv-123",
    }),
  };
}

function createMockModel() {
  return {
    id: "default",
    api: "copilot-studio",
    provider: "copilot-studio",
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function createMockContext(userText: string, systemPrompt?: string) {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }],
      },
    ],
    systemPrompt: systemPrompt ?? "",
    tools: [],
  };
}

/** Build a tool-call event activity matching the CS topic format. */
function toolCallActivity(toolName: string, args: Record<string, unknown>, replyToId?: string) {
  return {
    type: "event",
    name: "tool-call",
    ...(replyToId ? { replyToId } : {}),
    value: { tool_name: toolName, arguments: args },
  };
}

/** Collect all events from the async iterable stream. */
async function collectStreamEvents(
  stream: AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>,
): Promise<AssistantMessageEvent[]> {
  const resolved = await stream;
  const events: AssistantMessageEvent[] = [];
  for await (const event of resolved) {
    events.push(event);
  }
  return events;
}

const SESSION_KEY = "copilot-studio:copilot-studio:default";

describe("createCopilotStudioStreamFn", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClient = createMockClient();
    log = vi.fn();
    resetCopilotStudioConversation(SESSION_KEY);
  });

  it("creates a stream function", () => {
    const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
    expect(typeof streamFn).toBe("function");
  });

  it("queries client with user message", async () => {
    const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
    const model = createMockModel();
    const context = createMockContext("Hello there");

    const stream = streamFn(model as never, context as never, undefined);
    const events = await collectStreamEvents(stream);

    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.type).toBe("done");
    if (event.type === "done") {
      expect(event.message.content[0]).toEqual({
        type: "text",
        text: "Hello from Copilot Studio",
      });
    }
  });

  it("prepends system prompt on first message", async () => {
    const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
    const model = createMockModel();
    const context = createMockContext("Hello", "You are a helpful assistant");

    const stream = streamFn(model as never, context as never, undefined);
    await collectStreamEvents(stream);

    const callArgs = mockClient.query.mock.calls[0];
    expect(callArgs[0]).toContain("You are a helpful assistant");
    expect(callArgs[0]).toContain("Hello");
  });

  it("handles empty user message", async () => {
    const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
    const model = createMockModel();
    const context = {
      messages: [{ role: "user", content: [{ type: "text", text: "   " }] }],
      systemPrompt: "",
      tools: [],
    };

    const stream = streamFn(model as never, context as never, undefined);
    const events = await collectStreamEvents(stream);

    expect(mockClient.query).not.toHaveBeenCalled();
    const event = events[0];
    expect(event.type).toBe("done");
    if (event.type === "done") {
      expect(event.message.content[0]).toEqual({
        type: "text",
        text: "No user message found.",
      });
    }
  });

  it("handles client error", async () => {
    mockClient.query.mockRejectedValueOnce(new Error("Network error"));

    const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
    const model = createMockModel();
    const context = createMockContext("Hello");

    const stream = streamFn(model as never, context as never, undefined);
    const events = await collectStreamEvents(stream);

    const event = events[0];
    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.error.errorMessage).toBe("Network error");
    }
  });

  it("resetCopilotStudioConversation clears session state", () => {
    // Should not throw
    resetCopilotStudioConversation("some-session-key");
  });

  // --- Tool event bridging tests ---

  describe("tool event bridging", () => {
    it("converts tool-call events to ToolCall content blocks", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "Let me read that file for you.",
        activities: [toolCallActivity("read", { path: "src/index.ts" }, "tool-call-1")],
        adaptiveCards: [],
        conversationId: "conv-123",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();
      const context = createMockContext("Read src/index.ts");

      const stream = streamFn(model as never, context as never, undefined);
      const events = await collectStreamEvents(stream);

      expect(events.length).toBe(1);
      const event = events[0];
      expect(event.type).toBe("done");
      if (event.type === "done") {
        expect(event.message.stopReason).toBe("toolUse");
        expect(event.message.content).toHaveLength(2);
        expect(event.message.content[0]).toEqual({
          type: "text",
          text: "Let me read that file for you.",
        });
        const toolCall = event.message.content[1];
        expect(toolCall).toMatchObject({
          type: "toolCall",
          id: "tool-call-1",
          name: "read",
          arguments: { path: "src/index.ts" },
        });
      }
    });

    it("sends tool results back to CS as tool-result events", async () => {
      // Step 1: Initial query returns a tool-call event
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [toolCallActivity("read", { path: "src/index.ts" }, "tc-1")],
        adaptiveCards: [],
        conversationId: "conv-123",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();

      // First call: get tool call
      const context1 = createMockContext("Read the file");
      const stream1 = streamFn(model as never, context1 as never, undefined);
      const events1 = await collectStreamEvents(stream1);
      expect(events1[0].type).toBe("done");
      if (events1[0].type === "done") {
        expect(events1[0].message.stopReason).toBe("toolUse");
      }

      // Step 2: Simulate pi-agent-core executing the tool and calling StreamFn again
      mockClient.sendActivity.mockResolvedValueOnce({
        text: "The file contains: console.log('hello');",
        activities: [],
        adaptiveCards: [],
        conversationId: "conv-123",
      });

      const context2 = {
        messages: [
          { role: "user", content: [{ type: "text", text: "Read the file" }] },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/index.ts" } },
            ],
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "read",
            content: [{ type: "text", text: "console.log('hello');" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
        tools: [],
      };

      const stream2 = streamFn(model as never, context2 as never, undefined);
      const events2 = await collectStreamEvents(stream2);

      // Verify sendActivity was called with tool-result event
      expect(mockClient.sendActivity).toHaveBeenCalledTimes(1);
      expect(mockClient.sendActivity).toHaveBeenCalledWith("conv-123", {
        type: "event",
        name: "tool-result",
        replyToId: "tc-1",
        value: { tool_name: "read", result: "console.log('hello');", isError: false },
      });

      // Verify final text response
      expect(events2.length).toBe(1);
      if (events2[0].type === "done") {
        expect(events2[0].message.stopReason).toBe("stop");
        expect(events2[0].message.content[0]).toEqual({
          type: "text",
          text: "The file contains: console.log('hello');",
        });
      }
    });

    it("handles multi-turn tool loop", async () => {
      // Turn 1: CS wants to read a file
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [toolCallActivity("read", { path: "src/bug.ts" }, "tc-read")],
        adaptiveCards: [],
        conversationId: "conv-456",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();

      // Call 1: get read tool call
      const stream1 = streamFn(
        model as never,
        createMockContext("Fix the bug") as never,
        undefined,
      );
      const events1 = await collectStreamEvents(stream1);
      if (events1[0].type === "done") {
        expect(events1[0].message.stopReason).toBe("toolUse");
      }

      // Turn 2: Send read result, CS wants to edit the file
      mockClient.sendActivity.mockResolvedValueOnce({
        text: "I see the bug. Let me fix it.",
        activities: [
          toolCallActivity(
            "edit",
            { path: "src/bug.ts", oldText: "bug", newText: "fix" },
            "tc-edit",
          ),
        ],
        adaptiveCards: [],
        conversationId: "conv-456",
      });

      const context2 = {
        messages: [
          { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/bug.ts" } },
            ],
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "tc-read",
            toolName: "read",
            content: [{ type: "text", text: "const x = bug;" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
        tools: [],
      };

      const stream2 = streamFn(model as never, context2 as never, undefined);
      const events2 = await collectStreamEvents(stream2);

      // Should return another tool call (edit)
      if (events2[0].type === "done") {
        expect(events2[0].message.stopReason).toBe("toolUse");
        const editCall = events2[0].message.content.find(
          (c) => "type" in c && c.type === "toolCall" && "name" in c && c.name === "edit",
        );
        expect(editCall).toBeDefined();
      }

      // Turn 3: Send edit result, CS returns final text
      mockClient.sendActivity.mockResolvedValueOnce({
        text: "Done! The bug has been fixed.",
        activities: [],
        adaptiveCards: [],
        conversationId: "conv-456",
      });

      const context3 = {
        messages: [
          ...context2.messages,
          {
            role: "assistant",
            content: [
              { type: "text", text: "I see the bug. Let me fix it." },
              {
                type: "toolCall",
                id: "tc-edit",
                name: "edit",
                arguments: { path: "src/bug.ts", oldText: "bug", newText: "fix" },
              },
            ],
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "tc-edit",
            toolName: "edit",
            content: [{ type: "text", text: "File edited successfully." }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
        tools: [],
      };

      const stream3 = streamFn(model as never, context3 as never, undefined);
      const events3 = await collectStreamEvents(stream3);

      // Should return final text (no more tool calls)
      if (events3[0].type === "done") {
        expect(events3[0].message.stopReason).toBe("stop");
        expect(events3[0].message.content[0]).toEqual({
          type: "text",
          text: "Done! The bug has been fixed.",
        });
      }
    });

    it("handles multiple tool-call events in one response", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "I'll search for that.",
        activities: [
          toolCallActivity("find", { pattern: "**/*.ts" }, "tc-find"),
          toolCallActivity("grep", { pattern: "TODO", path: "src/" }, "tc-grep"),
        ],
        adaptiveCards: [],
        conversationId: "conv-789",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();
      const context = createMockContext("Find all TODOs in TypeScript files");

      const stream = streamFn(model as never, context as never, undefined);
      const events = await collectStreamEvents(stream);

      expect(events.length).toBe(1);
      if (events[0].type === "done") {
        const msg = events[0].message;
        expect(msg.stopReason).toBe("toolUse");
        // Should have text + 2 tool calls = 3 content blocks
        expect(msg.content).toHaveLength(3);
        expect(msg.content[0]).toMatchObject({ type: "text", text: "I'll search for that." });
        expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "find", id: "tc-find" });
        expect(msg.content[2]).toMatchObject({ type: "toolCall", name: "grep", id: "tc-grep" });
      }
    });

    it("enforces max tool round trips limit", async () => {
      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();

      // Initial query → tool-call event
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [toolCallActivity("read", { path: "a.ts" }, "tc-init")],
        adaptiveCards: [],
        conversationId: "conv-loop",
      });

      const stream1 = streamFn(model as never, createMockContext("go") as never, undefined);
      await collectStreamEvents(stream1);

      // Simulate tool round trips — each continuation returns another tool-call
      let lastToolCallId = "tc-init";
      for (let i = 0; i < 20; i++) {
        const newToolCallId = `tc-loop-${i}`;

        mockClient.sendActivity.mockResolvedValueOnce({
          text: "",
          activities: [toolCallActivity("read", { path: `file-${i}.ts` }, newToolCallId)],
          adaptiveCards: [],
          conversationId: "conv-loop",
        });

        const context = {
          messages: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            {
              role: "toolResult",
              toolCallId: lastToolCallId,
              toolName: "read",
              content: [{ type: "text", text: `content-${i}` }],
              isError: false,
              timestamp: Date.now(),
            },
          ],
          systemPrompt: "",
          tools: [],
        };

        const stream = streamFn(model as never, context as never, undefined);
        const events = await collectStreamEvents(stream);

        if (events[0].type === "done" && events[0].message.stopReason === "stop") {
          const text = (events[0].message.content[0] as { text: string }).text;
          if (text.includes("loop limit exceeded")) {
            expect(i).toBeLessThanOrEqual(20);
            return;
          }
        }

        lastToolCallId = newToolCallId;
      }

      // One more should definitely hit the limit
      mockClient.sendActivity.mockResolvedValueOnce({
        text: "",
        activities: [],
        adaptiveCards: [],
        conversationId: "conv-loop",
      });

      const finalContext = {
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "toolResult",
            toolCallId: lastToolCallId,
            toolName: "read",
            content: [{ type: "text", text: "final" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
        tools: [],
      };

      const finalStream = streamFn(model as never, finalContext as never, undefined);
      const finalEvents = await collectStreamEvents(finalStream);

      if (finalEvents[0].type === "done") {
        const text = (finalEvents[0].message.content[0] as { text: string }).text;
        expect(text).toContain("loop limit exceeded");
      }
    });

    it("ignores non-tool-call events", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "Here are the results.",
        activities: [
          // Citation event — not a tool-call
          { type: "event", name: "citation", value: "https://example.com" },
          // Random event — not a tool-call
          { type: "event", name: "some-other-event", value: { some: "data" } },
          // Message activity — not an event
          { type: "message", text: "Here are the results." },
        ],
        adaptiveCards: [],
        conversationId: "conv-cit",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();
      const context = createMockContext("search something");

      const stream = streamFn(model as never, context as never, undefined);
      const events = await collectStreamEvents(stream);

      expect(events.length).toBe(1);
      if (events[0].type === "done") {
        // Should be a plain text response, not tool use
        expect(events[0].message.stopReason).toBe("stop");
        expect(events[0].message.content).toHaveLength(1);
        expect(events[0].message.content[0]).toMatchObject({
          type: "text",
          text: "Here are the results.",
        });
      }
    });

    it("generates UUIDs for tool calls without replyToId", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [
          {
            type: "event",
            name: "tool-call",
            // No replyToId
            value: { tool_name: "exec", arguments: { command: "ls -la" } },
          },
        ],
        adaptiveCards: [],
        conversationId: "conv-uuid",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();
      const context = createMockContext("list files");

      const stream = streamFn(model as never, context as never, undefined);
      const events = await collectStreamEvents(stream);

      if (events[0].type === "done") {
        expect(events[0].message.stopReason).toBe("toolUse");
        const toolCall = events[0].message.content.find(
          (c) => "type" in c && c.type === "toolCall",
        );
        expect(toolCall).toBeDefined();
        if (toolCall && "id" in toolCall) {
          expect(typeof toolCall.id).toBe("string");
          expect(toolCall.id.length).toBeGreaterThan(0);
        }
      }
    });

    it("handles tool result with isError=true", async () => {
      // First: return a tool-call event
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [toolCallActivity("exec", { command: "bad-cmd" }, "tc-err")],
        adaptiveCards: [],
        conversationId: "conv-err",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();

      const stream1 = streamFn(
        model as never,
        createMockContext("run bad-cmd") as never,
        undefined,
      );
      await collectStreamEvents(stream1);

      // Second call with error result
      mockClient.sendActivity.mockResolvedValueOnce({
        text: "The command failed. Let me try something else.",
        activities: [],
        adaptiveCards: [],
        conversationId: "conv-err",
      });

      const context2 = {
        messages: [
          { role: "user", content: [{ type: "text", text: "run bad-cmd" }] },
          {
            role: "toolResult",
            toolCallId: "tc-err",
            toolName: "exec",
            content: [{ type: "text", text: "command not found: bad-cmd" }],
            isError: true,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
        tools: [],
      };

      const stream2 = streamFn(model as never, context2 as never, undefined);
      await collectStreamEvents(stream2);

      // Verify tool-result event with isError=true
      expect(mockClient.sendActivity).toHaveBeenCalledWith("conv-err", {
        type: "event",
        name: "tool-result",
        replyToId: "tc-err",
        value: { tool_name: "exec", result: "command not found: bad-cmd", isError: true },
      });
    });

    it("only returns tool calls when CS sends tool-call events (no text)", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [toolCallActivity("write", { path: "out.txt", content: "hello" }, "tc-write")],
        adaptiveCards: [],
        conversationId: "conv-no-text",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();
      const context = createMockContext("write hello to out.txt");

      const stream = streamFn(model as never, context as never, undefined);
      const events = await collectStreamEvents(stream);

      if (events[0].type === "done") {
        expect(events[0].message.stopReason).toBe("toolUse");
        // No text content when CS didn't send any
        expect(events[0].message.content).toHaveLength(1);
        expect(events[0].message.content[0]).toMatchObject({
          type: "toolCall",
          name: "write",
        });
      }
    });

    it("extracts tool_name from value when event.name is tool-call", async () => {
      mockClient.query.mockResolvedValueOnce({
        text: "",
        activities: [
          {
            type: "event",
            name: "tool-call",
            replyToId: "tc-x",
            value: { tool_name: "web_search", arguments: { query: "hello" } },
          },
        ],
        adaptiveCards: [],
        conversationId: "conv-extract",
      });

      const streamFn = createCopilotStudioStreamFn(mockClient as never, log);
      const model = createMockModel();

      const stream = streamFn(
        model as never,
        createMockContext("search hello") as never,
        undefined,
      );
      const events = await collectStreamEvents(stream);

      if (events[0].type === "done") {
        expect(events[0].message.stopReason).toBe("toolUse");
        expect(events[0].message.content[0]).toMatchObject({
          type: "toolCall",
          id: "tc-x",
          name: "web_search",
          arguments: { query: "hello" },
        });
      }
    });
  });
});
