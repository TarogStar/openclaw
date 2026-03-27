import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ToolLoadSchema = Type.Object({
  tools: Type.String({
    description:
      "Comma-separated tool names to load (e.g. 'email,calendar'). " +
      "Only tools marked [load required] in the tool list need loading.",
  }),
});

export type ToolLoadOptions = {
  /** All tool names registered in the system (for validation). */
  allToolNames: string[];
  /** Core tool names that are always loaded (no need to load). */
  coreToolNames: Set<string>;
  /** Callback invoked with validated tool names when tool_load is called. */
  onLoad: (names: string[]) => void;
};

export function createToolLoadTool(opts: ToolLoadOptions): AnyAgentTool {
  return {
    label: "Load Tools",
    name: "tool_load",
    description:
      "Load additional tool schemas. After calling this, STOP and end your response immediately. " +
      "The requested tools will become available in your next turn. Do NOT attempt to use the tools in the same turn.",
    parameters: ToolLoadSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const rawTools = readStringParam(params, "tools", { required: true });
      const requested = rawTools
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);

      if (requested.length === 0) {
        return jsonResult({
          error: "no_tools_specified",
          message: "Specify at least one tool name to load.",
        });
      }

      const allNamesLower = new Set(opts.allToolNames.map((n) => n.toLowerCase()));
      const valid: string[] = [];
      const alreadyLoaded: string[] = [];
      const unknown: string[] = [];

      for (const name of requested) {
        if (!allNamesLower.has(name)) {
          unknown.push(name);
        } else if (opts.coreToolNames.has(name)) {
          alreadyLoaded.push(name);
        } else {
          valid.push(name);
        }
      }

      if (valid.length > 0) {
        opts.onLoad(valid);
      }

      const parts: string[] = [];
      if (valid.length > 0) {
        parts.push(`Loaded: ${valid.join(", ")}.`);
      }
      if (alreadyLoaded.length > 0) {
        parts.push(`Already available: ${alreadyLoaded.join(", ")}.`);
      }
      if (unknown.length > 0) {
        parts.push(`Unknown tools (ignored): ${unknown.join(", ")}.`);
      }
      if (valid.length > 0) {
        parts.push(
          "IMPORTANT: End your response NOW. The tools will be available in your next turn. " +
            "Do NOT try to call these tools yet.",
        );
      }

      return jsonResult({
        loaded: valid,
        alreadyLoaded,
        unknown,
        message: parts.join(" "),
      });
    },
  };
}
