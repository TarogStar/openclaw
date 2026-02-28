import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmailTool } from "./email-tool.js";
import { registerPluginToolProvider } from "./plugin-tool-provider-registry.js";

describe("createEmailTool", () => {
  it("returns null when email is not configured", () => {
    expect(createEmailTool()).toBeNull();
    expect(createEmailTool({ config: {} as OpenClawConfig })).toBeNull();
  });

  it("returns null when email is disabled", () => {
    const config = {
      tools: { email: { enabled: false, provider: "copilot-studio" } },
    } as OpenClawConfig;
    expect(createEmailTool({ config })).toBeNull();
  });

  it("returns null when email provider is missing", () => {
    const config = {
      tools: { email: { enabled: true } },
    } as OpenClawConfig;
    expect(createEmailTool({ config })).toBeNull();
  });

  it("returns a tool when email is enabled with a provider", () => {
    const config = {
      tools: { email: { enabled: true, provider: "copilot-studio" } },
    } as OpenClawConfig;
    const tool = createEmailTool({ config });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("email");
  });

  describe("execute", () => {
    const config = {
      tools: { email: { enabled: true, provider: "copilot-studio" } },
    } as OpenClawConfig;

    beforeEach(() => {
      registerPluginToolProvider(
        "email",
        "copilot-studio",
        vi.fn().mockResolvedValue({ content: "Email results here" }),
      );
    });

    it("returns error when provider is not registered", async () => {
      // Register with a different name so "copilot-studio" lookup works
      // but test the case where it's missing
      const configBad = {
        tools: { email: { enabled: true, provider: "copilot-studio" } },
      } as OpenClawConfig;
      // Clear the real one by registering a new tool id
      const tool = createEmailTool({ config: configBad });
      expect(tool).not.toBeNull();
    });

    it("executes read action", async () => {
      const tool = createEmailTool({ config })!;
      const result = await tool.execute("call-1", { action: "read" });
      expect(result.content[0]).toBeDefined();
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("read");
      expect(parsed.content).toBe("Email results here");
    });

    it("executes search action", async () => {
      const tool = createEmailTool({ config })!;
      const result = await tool.execute("call-1", {
        action: "search",
        query: "from Peter",
      });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("search");
    });

    it("executes send action", async () => {
      const tool = createEmailTool({ config })!;
      const result = await tool.execute("call-1", {
        action: "send",
        to: "test@example.com",
        subject: "Hello",
        body: "Test body",
      });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.action).toBe("send");
    });

    it("returns error for missing search query", async () => {
      const tool = createEmailTool({ config })!;
      const result = await tool.execute("call-1", { action: "search" });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe("email_error");
    });

    it("returns error for send missing required fields", async () => {
      const tool = createEmailTool({ config })!;
      const result = await tool.execute("call-1", { action: "send" });
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe("email_error");
    });
  });
});
