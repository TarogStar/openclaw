import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { getPluginToolProvider } from "./plugin-tool-provider-registry.js";

const CALENDAR_ACTIONS = ["check", "search", "create"] as const;

const CalendarSchema = Type.Object({
  action: stringEnum([...CALENDAR_ACTIONS], {
    description:
      "Action to perform: 'check' (upcoming events), 'search' (find events), 'create' (new event).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "For 'check': timeframe like 'today', 'tomorrow', 'this week'. For 'search': search terms. Not used for 'create'.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Event title (required for 'create')." })),
  datetime: Type.Optional(
    Type.String({
      description:
        "Event date/time in natural language, e.g. 'tomorrow at 2pm' (required for 'create').",
    }),
  ),
  duration: Type.Optional(
    Type.String({
      description: "Event duration, e.g. '30 minutes', '1 hour'. Defaults to 30 minutes.",
    }),
  ),
  attendees: Type.Optional(
    Type.String({ description: "Comma-separated attendee email addresses." }),
  ),
});

function resolveCalendarConfig(config?: OpenClawConfig) {
  return config?.tools?.calendar;
}

function buildCalendarPrompt(action: string, params: Record<string, unknown>): string {
  switch (action) {
    case "check": {
      const query =
        (typeof params.query === "string" ? params.query.trim() : "") || "next 24 hours";
      return `Check my calendar for ${query}. List each event with time, title, and attendees. Be concise.`;
    }
    case "search": {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new Error("query required for search");
      }
      return `Search my calendar for events matching: ${query}. List matching events with date, time, title, and attendees.`;
    }
    case "create": {
      const title = typeof params.title === "string" ? params.title.trim() : "";
      const datetime = typeof params.datetime === "string" ? params.datetime.trim() : "";
      if (!title) {
        throw new Error("title required");
      }
      if (!datetime) {
        throw new Error("datetime required");
      }
      const duration =
        (typeof params.duration === "string" ? params.duration.trim() : "") || "30 minutes";
      const attendees = typeof params.attendees === "string" ? params.attendees.trim() : "";
      return attendees
        ? `Create a calendar event: "${title}" at ${datetime}, duration ${duration}, with attendees: ${attendees}. Confirm when created.`
        : `Create a calendar event: "${title}" at ${datetime}, duration ${duration}. Confirm when created.`;
    }
    default:
      throw new Error(`Unknown calendar action: ${action}. Use 'check', 'search', or 'create'.`);
  }
}

export function createCalendarTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const calendarConfig = resolveCalendarConfig(options?.config);
  if (!calendarConfig?.enabled || !calendarConfig?.provider) {
    return null;
  }

  const provider = calendarConfig.provider;

  return {
    label: "Calendar",
    name: "calendar",
    description:
      "Check, search, or create calendar events via Microsoft 365. Use action='check' for upcoming events, 'search' to find specific events, 'create' to schedule a new event.",
    parameters: CalendarSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const executor = getPluginToolProvider("calendar", provider);
      if (!executor) {
        return jsonResult({
          error: "provider_not_registered",
          message: `Calendar provider "${provider}" not registered. Enable the ${provider} plugin.`,
        });
      }

      try {
        const prompt = buildCalendarPrompt(action, params);
        const { content, citations, structured } = await executor(prompt, {
          action,
          ...params,
        });

        return jsonResult({
          action,
          provider,
          content,
          ...(citations?.length ? { citations } : {}),
          ...(structured ? { structured } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: "calendar_error",
          message: `calendar (${action}) failed: ${message}`,
        });
      }
    },
  };
}
