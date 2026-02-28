import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  StopReason,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { enqueuePendingCards } from "./adaptive-card-queue.js";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient, QueryResult, SSEActivity } from "./client.js";

/** How long a conversation session stays valid before we start a fresh one. */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Safety limit to prevent infinite tool call loops. */
const MAX_TOOL_ROUND_TRIPS = 20;

/** Event name CS sends when it wants to call a tool. */
const TOOL_CALL_EVENT = "tool-call";
/** Event name OpenClaw sends back with the tool result. */
const TOOL_RESULT_EVENT = "tool-result";

type ConversationSession = {
  conversationId: string;
  lastActiveAt: number;
  /** Tool call IDs we're awaiting results for from pi-agent-core. */
  pendingToolCallIds?: Set<string>;
  /** Number of tool round trips in the current turn. */
  toolRoundTrips: number;
};

/** Per-sessionKey conversation state (keyed by session key). */
const sessions = new Map<string, ConversationSession>();

/** Clear conversation state for a session (called on /new or /reset). */
export function resetCopilotStudioConversation(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/**
 * Build a Pi SDK AssistantMessage from CS response text.
 * Matches the pattern used by the Ollama stream function.
 */
function buildAssistantMessage(text: string, model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop" as StopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

/**
 * Extract tool-call event activities from a CS QueryResult.
 * CS sends a single event name ("tool-call") with tool_name + arguments inside value.
 */
function extractToolEvents(result: QueryResult): SSEActivity[] {
  return result.activities.filter((a) => a.type === "event" && a.name === TOOL_CALL_EVENT);
}

/**
 * Convert CS tool-call events to Pi SDK ToolCall content blocks.
 * Value shape: { tool_name: string, arguments: Record<string, unknown> }
 */
function eventToToolCalls(events: SSEActivity[]): ToolCall[] {
  return events.map((event) => {
    const val = (
      typeof event.value === "object" && event.value !== null ? event.value : {}
    ) as Record<string, unknown>;
    const toolName = typeof val.tool_name === "string" ? val.tool_name : "unknown";
    const args = (
      typeof val.arguments === "object" && val.arguments !== null ? val.arguments : {}
    ) as Record<string, never>;
    return {
      type: "toolCall" as const,
      id: event.replyToId || crypto.randomUUID(),
      name: toolName,
      arguments: args,
    };
  });
}

/**
 * Find trailing ToolResultMessages in context.messages that match pending tool call IDs.
 * Returns them in order so we can send results back to CS.
 */
function findTrailingToolResults(
  messages: Array<{
    role: string;
    content: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  }>,
  pendingIds: Set<string>,
): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  // Walk backwards from the end to find trailing tool results
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "toolResult") break;
    if (msg.toolCallId && pendingIds.has(msg.toolCallId)) {
      results.unshift(msg as unknown as ToolResultMessage);
    }
  }
  return results;
}

/**
 * Process a CS QueryResult: check for tool events or return final text.
 * Returns the AssistantMessage to push to the stream.
 */
function buildResponseMessage(
  result: QueryResult,
  toolEvents: SSEActivity[],
  model: Model<Api>,
  session: ConversationSession,
): AssistantMessage {
  if (toolEvents.length === 0) {
    return buildAssistantMessage(result.text, model);
  }

  // Convert tool events to ToolCall content blocks
  const toolCalls = eventToToolCalls(toolEvents);

  // Track pending tool call IDs so we can match results later
  session.pendingToolCallIds = new Set(toolCalls.map((tc) => tc.id));

  const content: (TextContent | ToolCall)[] = [];
  // Include any text from CS (e.g. "Let me read that file...")
  if (result.text) {
    content.push({ type: "text" as const, text: result.text });
  }
  content.push(...toolCalls);

  return {
    role: "assistant",
    content,
    stopReason: "toolUse" as StopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

/**
 * Create a Pi SDK stream function that routes through Copilot Studio.
 *
 * The stream function handles two cases:
 * - Case A (user message): Extract last user message, send to CS, check for tool events
 * - Case B (tool result continuation): Send tool results back to CS as event activities,
 *   then check CS's continuation response for more tool events or final text
 */
export function createCopilotStudioStreamFn(
  client: CopilotStudioClient,
  log: (msg: string) => void,
): StreamFn {
  return (model, context, _options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const sessionKey = `copilot-studio:${model.provider}:${model.id}`;
        const messages = (context.messages ?? []) as Array<{
          role: string;
          content: unknown;
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
        }>;

        // Check if this is a tool result continuation (Case B)
        const existing = sessions.get(sessionKey);
        if (existing?.pendingToolCallIds && existing.pendingToolCallIds.size > 0) {
          const trailingResults = findTrailingToolResults(messages, existing.pendingToolCallIds);

          if (trailingResults.length > 0) {
            // Safety check: prevent infinite tool loops
            existing.toolRoundTrips++;
            if (existing.toolRoundTrips > MAX_TOOL_ROUND_TRIPS) {
              existing.pendingToolCallIds = undefined;
              stream.push({
                type: "done",
                reason: "stop",
                message: buildAssistantMessage(
                  `Tool call loop limit exceeded (${MAX_TOOL_ROUND_TRIPS} round trips). Stopping.`,
                  model,
                ),
              });
              return;
            }

            // Send each tool result back to CS as an event activity
            let continuationResult: QueryResult | undefined;
            for (const toolResult of trailingResults) {
              const textContent = (toolResult.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("\n");

              log(
                `[copilot-studio] sending tool result: ${toolResult.toolName} (${textContent.length} chars, isError=${toolResult.isError})`,
              );

              continuationResult = await client.sendActivity(existing.conversationId, {
                type: "event",
                name: TOOL_RESULT_EVENT,
                replyToId: toolResult.toolCallId,
                value: {
                  tool_name: toolResult.toolName,
                  result: textContent,
                  isError: toolResult.isError,
                },
              });
              existing.lastActiveAt = Date.now();
            }

            // Clear pending IDs now that we've sent all results
            existing.pendingToolCallIds = undefined;

            if (!continuationResult) {
              stream.push({
                type: "done",
                reason: "stop",
                message: buildAssistantMessage(
                  "No continuation response from Copilot Studio.",
                  model,
                ),
              });
              return;
            }

            // Process the continuation response — may contain more tool events
            const toolEvents = extractToolEvents(continuationResult);
            for (const activity of toolEvents) {
              log(
                `[copilot-studio] tool event (continuation): ${activity.name} value=${JSON.stringify(activity.value).slice(0, 200)}`,
              );
            }

            // Forward adaptive cards from continuation
            if (continuationResult.adaptiveCards.length > 0) {
              enqueuePendingCards({
                cards: continuationResult.adaptiveCards,
                conversationId: continuationResult.conversationId,
                text: continuationResult.text || undefined,
                timestamp: Date.now(),
              });
            }

            const msg = buildResponseMessage(continuationResult, toolEvents, model, existing);
            stream.push({ type: "done", reason: msg.stopReason, message: msg });
            return;
          }
        }

        // Case A: User message (first call or new message)
        const lastUserMessage = messages.filter((m) => m.role === "user").pop();

        let userText = "";
        if (lastUserMessage) {
          const content = lastUserMessage.content;
          if (typeof content === "string") {
            userText = content;
          } else if (Array.isArray(content)) {
            userText = content
              .filter(
                (c): c is { type: "text"; text: string } =>
                  typeof c === "object" && c !== null && "type" in c && c.type === "text",
              )
              .map((c) => c.text)
              .join("\n");
          }
        }

        if (!userText.trim()) {
          stream.push({
            type: "done",
            reason: "stop",
            message: buildAssistantMessage("No user message found.", model),
          });
          return;
        }

        const now = Date.now();
        let result: QueryResult;

        if (existing && now - existing.lastActiveAt < SESSION_TTL_MS) {
          try {
            result = await client.continueConversation(existing.conversationId, userText);
            existing.lastActiveAt = now;
            existing.conversationId = result.conversationId;
            existing.toolRoundTrips = 0;
          } catch (err) {
            if (err instanceof DeviceCodeRequiredError) throw err;
            log(
              `[copilot-studio] continueConversation failed, starting new: ${err instanceof Error ? err.message : String(err)}`,
            );
            sessions.delete(sessionKey);
            result = await client.query(userText);
            sessions.set(sessionKey, {
              conversationId: result.conversationId,
              lastActiveAt: now,
              toolRoundTrips: 0,
            });
          }
        } else {
          // First message or expired session — prepend system prompt for context
          const systemPrompt = context.systemPrompt ?? "";
          const prompt = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;
          result = await client.query(prompt);
          sessions.set(sessionKey, {
            conversationId: result.conversationId,
            lastActiveAt: now,
            toolRoundTrips: 0,
          });
        }

        // Forward adaptive cards to the channel
        if (result.adaptiveCards.length > 0) {
          enqueuePendingCards({
            cards: result.adaptiveCards,
            conversationId: result.conversationId,
            text: result.text || undefined,
            timestamp: Date.now(),
          });
        }

        // Check for tool event activities
        const toolEvents = extractToolEvents(result);
        for (const activity of toolEvents) {
          log(
            `[copilot-studio] tool event: ${activity.name} value=${JSON.stringify(activity.value).slice(0, 200)}`,
          );
        }

        // Get or create session for tracking tool state
        const session = sessions.get(sessionKey) ?? {
          conversationId: result.conversationId,
          lastActiveAt: now,
          toolRoundTrips: 0,
        };
        if (!sessions.has(sessionKey)) sessions.set(sessionKey, session);

        const msg = buildResponseMessage(result, toolEvents, model, session);
        stream.push({ type: "done", reason: msg.stopReason, message: msg });
      } catch (err) {
        if (err instanceof DeviceCodeRequiredError) {
          // Return auth instructions as assistant text (not error)
          enqueuePendingCards({
            cards: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.4",
                  body: [
                    {
                      type: "TextBlock",
                      text: "Microsoft Authentication Required",
                      weight: "Bolder",
                      size: "Medium",
                    },
                    {
                      type: "TextBlock",
                      text: "To use Copilot Studio, please sign in:",
                      wrap: true,
                    },
                    {
                      type: "TextBlock",
                      text: `**Code:** ${err.userCode}`,
                      wrap: true,
                      size: "Large",
                      fontType: "Monospace",
                    },
                  ],
                  actions: [
                    {
                      type: "Action.OpenUrl",
                      title: "Sign in at microsoft.com/devicelogin",
                      url: err.verificationUri,
                    },
                  ],
                },
              },
            ],
            conversationId: "auth-prompt",
            text: `Authenticate at ${err.verificationUri} with code: ${err.userCode}`,
            timestamp: Date.now(),
          });

          stream.push({
            type: "done",
            reason: "stop",
            message: buildAssistantMessage(
              `Authentication is required. Please sign in at ${err.verificationUri} ` +
                `with code **${err.userCode}**, then send your message again.`,
              model,
            ),
          });
          return;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`[copilot-studio] stream function error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
