import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createCalendarTool } from "./calendar-tool.js";
import { registerPluginToolProvider } from "./plugin-tool-provider-registry.js";

describe("createCalendarTool", () => {
  it("returns null when calendar is not configured", () => {
    expect(createCalendarTool()).toBeNull();
    expect(createCalendarTool({ config: {} as OpenClawConfig })).toBeNull();
  });

  it("returns null when calendar is disabled", () => {
    const config = {
      tools: { calendar: { enabled: false, provider: "copilot-studio" } },
    } as OpenClawConfig;
    expect(createCalendarTool({ config })).toBeNull();
  });

  it("returns null when calendar provider is missing", () => {
    const config = {
      tools: { calendar: { enabled: true } },
    } as OpenClawConfig;
    expect(createCalendarTool({ config })).toBeNull();
  });

  it("returns a tool when calendar is enabled with a provider", () => {
    const config = {
      tools: { calendar: { enabled: true, provider: "copilot-studio" } },
    } as OpenClawConfig;
    const tool = createCalendarTool({ config });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("calendar");
  });

  describe("execute", () => {
    const config = {
      tools: { calendar: { enabled: true, provider: "copilot-studio" } },
    } as OpenClawConfig;

    beforeEach(() => {
      registerPluginToolProvider(
        "calendar",
        "copilot-studio",
        vi.fn().mockResolvedValue({ content: "Calendar results here" }),
      );
    });

    it("executes check action", async () => {
      const tool = createCalendarTool({ config })!;
      const result = await tool.execute("call-1", { action: "check" });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("check");
      expect(parsed.content).toBe("Calendar results here");
    });

    it("executes search action", async () => {
      const tool = createCalendarTool({ config })!;
      const result = await tool.execute("call-1", {
        action: "search",
        query: "standup",
      });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("search");
    });

    it("executes create action", async () => {
      const tool = createCalendarTool({ config })!;
      const result = await tool.execute("call-1", {
        action: "create",
        title: "Team Meeting",
        datetime: "tomorrow at 2pm",
        duration: "1 hour",
      });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("create");
    });

    it("returns error for missing search query", async () => {
      const tool = createCalendarTool({ config })!;
      const result = await tool.execute("call-1", { action: "search" });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe("calendar_error");
    });

    it("returns error for create missing required fields", async () => {
      const tool = createCalendarTool({ config })!;
      const result = await tool.execute("call-1", { action: "create" });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe("calendar_error");
    });
  });
});
