import { enqueuePendingCards } from "./adaptive-card-queue.js";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient, QueryResult } from "./client.js";
import {
  storePendingConversation,
  popPendingConversation,
  popPendingInvoke,
} from "./pending-conversations.js";

// Max characters for tool result text to prevent blowing up local model context
const MAX_RESULT_CHARS = 3000;

// Re-usable helpers (same pattern as OpenClaw core tools)
function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text:
          text.length > MAX_RESULT_CHARS
            ? text.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)"
            : text,
      },
    ],
    details: payload,
  };
}

function readString(params: Record<string, unknown>, key: string, required = false): string {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) throw new Error(`${key} is required`);
    return "";
  }
  return raw.trim();
}

/**
 * Build a tool result from a QueryResult. If the result contains adaptive cards
 * (e.g. consent prompts), returns them as structured data so the channel can
 * forward them natively instead of losing them.
 */
function buildQueryToolResult(
  result: QueryResult,
  meta: Record<string, unknown>,
  toolName: string,
) {
  if (result.adaptiveCards.length > 0) {
    // Enqueue cards for the channel to send natively (e.g. as Teams adaptive cards)
    enqueuePendingCards({
      cards: result.adaptiveCards,
      conversationId: result.conversationId,
      text: result.text || undefined,
      timestamp: Date.now(),
    });

    // Store conversation for follow-up (e.g. user clicks Allow on consent card)
    storePendingConversation({
      conversationId: result.conversationId,
      toolName,
      timestamp: Date.now(),
    });

    // Don't include card JSON in tool result — the cards are already enqueued
    // for native delivery. The LLM just needs to know a consent card was sent
    // and should wait for the user to respond.
    return jsonResult({
      ...meta,
      status: "consent_required",
      message:
        "A permission consent card has been sent to the user. " +
        "Wait for them to click Allow, then call this tool again with the same parameters.",
    });
  }

  // Check for event activities that carry structured data (e.g. DynamicPlan*)
  const eventActivities = result.activities.filter((a) => a.type === "event" && a.name);
  if (eventActivities.length > 0) {
    return jsonResult({
      ...meta,
      content: result.text,
      events: eventActivities.map((a) => ({
        name: a.name,
        value: a.value,
      })),
    });
  }

  return jsonResult({
    ...meta,
    content: result.text,
  });
}

/**
 * Execute a query, checking first for a pending conversation to continue
 * (e.g. after user clicked Allow on a consent card). If a pending conversation
 * exists for this tool, continues that conversation instead of starting new.
 *
 * Two-step consent flow:
 * 1. Send consent value (empty text) → Copilot Studio processes consent
 * 2. If consent response has actual data → return it
 *    If consent response is just a confirmation → send the original prompt
 */
async function queryOrContinue(
  client: CopilotStudioClient,
  prompt: string,
  toolName: string,
): Promise<QueryResult> {
  const pending = popPendingConversation(toolName);
  if (pending) {
    // Check for pending invoke data (e.g. user clicked Allow on consent card).
    // Send the Action.Submit value data back to Copilot Studio so it can
    // process the consent acknowledgment.
    const invoke = popPendingInvoke();
    const activityValue = invoke?.actionData;

    // Step 1: Send consent value with empty text
    const consentResult = await client.continueConversation(
      pending.conversationId,
      prompt,
      undefined,
      activityValue,
    );

    // If consent response already has substantive data or new cards, return it
    if (consentResult.text.length > 50 || consentResult.adaptiveCards.length > 0) {
      return consentResult;
    }

    // Step 2: Consent was acknowledged but Copilot Studio didn't auto-continue.
    // Send the original prompt in the same conversation to get actual data.
    return await client.continueConversation(consentResult.conversationId, prompt);
  }
  return await client.query(prompt);
}

/**
 * Handle errors from tool execution. If auth is needed, returns a
 * user-friendly message with the device code URL so the LLM can relay it.
 */
function handleToolError(err: unknown, toolName: string) {
  if (err instanceof DeviceCodeRequiredError) {
    return jsonResult({
      error: "auth_required",
      message:
        `I need you to authenticate with Microsoft to use ${toolName}. ` +
        `Go to ${err.verificationUri} and enter code: **${err.userCode}**. ` +
        `Once done, try again and it should work.`,
      verificationUri: err.verificationUri,
      userCode: err.userCode,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({
    error: "copilot_studio_error",
    message: `${toolName} failed: ${message}`,
  });
}

// ---------------------------------------------------------------------------
// Web Search Tool
// ---------------------------------------------------------------------------
const WebSearchSchema = {
  type: "object" as const,
  properties: {
    query: { type: "string" as const, description: "Search query string." },
  },
  required: ["query"],
};

export function createCopilotWebSearchTool(client: CopilotStudioClient) {
  return {
    label: "Web Search",
    name: "web_search",
    description:
      "Search the web for current information. Returns a concise answer with source URLs.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const query = readString(params, "query", true);

      try {
        const prompt = [
          `Search the web for: ${query}`,
          "",
          "Return a concise 2-3 sentence answer followed by up to 5 source URLs.",
          "Be factual and brief. Format:",
          "[Answer]",
          "",
          "Sources:",
          "- [Title](URL)",
        ].join("\n");

        const result = await queryOrContinue(client, prompt, "web_search");

        return buildQueryToolResult(result, { query, provider: "copilot-studio" }, "web_search");
      } catch (err) {
        return handleToolError(err, "web_search");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Email Tool
// ---------------------------------------------------------------------------
const EmailSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["read", "search", "send"],
      description:
        "Action to perform: 'read' (recent emails), 'search' (find specific emails), 'send' (compose and send).",
    },
    query: {
      type: "string" as const,
      description:
        "For 'read': optional filter (e.g. 'unread', 'from John'). For 'search': search terms. Not used for 'send'.",
    },
    to: {
      type: "string" as const,
      description: "Recipient email address (required for 'send').",
    },
    subject: {
      type: "string" as const,
      description: "Email subject (required for 'send').",
    },
    body: {
      type: "string" as const,
      description: "Email body text (required for 'send').",
    },
  },
  required: ["action"],
};

export function createCopilotEmailTool(client: CopilotStudioClient) {
  return {
    label: "Email",
    name: "email",
    description:
      "Read, search, or send email via Microsoft 365. Use action='read' for recent mail, 'search' to find specific emails, 'send' to compose and send.",
    parameters: EmailSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readString(params, "action", true);

      try {
        let prompt: string;

        switch (action) {
          case "read": {
            const query = readString(params, "query");
            prompt = query
              ? `Check my recent emails. Filter: ${query}. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.`
              : "Check my recent emails. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.";
            break;
          }
          case "search": {
            const query = readString(params, "query", true);
            prompt = `Search my emails for: ${query}. List up to 5 matches with sender, subject, date, and a brief summary. Do not include full email bodies.`;
            break;
          }
          case "send": {
            const to = readString(params, "to", true);
            const subject = readString(params, "subject", true);
            const body = readString(params, "body", true);
            prompt = `Send an email to ${to} with subject "${subject}" and body:\n\n${body}\n\nConfirm when sent.`;
            break;
          }
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown email action: ${action}. Use 'read', 'search', or 'send'.`,
            });
        }

        const result = await queryOrContinue(client, prompt, "email");

        return buildQueryToolResult(result, { action, provider: "copilot-studio" }, "email");
      } catch (err) {
        return handleToolError(err, "email");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Calendar Tool
// ---------------------------------------------------------------------------
const CalendarSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["check", "create", "search"],
      description:
        "Action to perform: 'check' (upcoming events), 'search' (find events), 'create' (new event).",
    },
    query: {
      type: "string" as const,
      description:
        "For 'check': timeframe like 'today', 'tomorrow', 'this week'. For 'search': search terms. Not used for 'create'.",
    },
    title: {
      type: "string" as const,
      description: "Event title (required for 'create').",
    },
    datetime: {
      type: "string" as const,
      description:
        "Event date/time in natural language, e.g. 'tomorrow at 2pm' (required for 'create').",
    },
    duration: {
      type: "string" as const,
      description: "Event duration, e.g. '30 minutes', '1 hour'. Defaults to 30 minutes.",
    },
    attendees: {
      type: "string" as const,
      description: "Comma-separated attendee email addresses.",
    },
  },
  required: ["action"],
};

export function createCopilotCalendarTool(client: CopilotStudioClient) {
  return {
    label: "Calendar",
    name: "calendar",
    description:
      "Check, search, or create calendar events via Microsoft 365. Use action='check' for upcoming events, 'search' to find specific events, 'create' to schedule a new event.",
    parameters: CalendarSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readString(params, "action", true);

      try {
        let prompt: string;

        switch (action) {
          case "check": {
            const query = readString(params, "query") || "next 24 hours";
            prompt = `Check my calendar for ${query}. List each event with time, title, and attendees. Be concise.`;
            break;
          }
          case "search": {
            const query = readString(params, "query", true);
            prompt = `Search my calendar for events matching: ${query}. List matching events with date, time, title, and attendees.`;
            break;
          }
          case "create": {
            const title = readString(params, "title", true);
            const datetime = readString(params, "datetime", true);
            const duration = readString(params, "duration") || "30 minutes";
            const attendees = readString(params, "attendees");
            prompt = attendees
              ? `Create a calendar event: "${title}" at ${datetime}, duration ${duration}, with attendees: ${attendees}. Confirm when created.`
              : `Create a calendar event: "${title}" at ${datetime}, duration ${duration}. Confirm when created.`;
            break;
          }
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown calendar action: ${action}. Use 'check', 'search', or 'create'.`,
            });
        }

        const result = await queryOrContinue(client, prompt, "calendar");

        return buildQueryToolResult(result, { action, provider: "copilot-studio" }, "calendar");
      } catch (err) {
        return handleToolError(err, "calendar");
      }
    },
  };
}
