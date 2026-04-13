import { describe, expect, it, vi } from "vitest";
import { createToolLoadTool } from "./tool-load-tool.js";

describe("createToolLoadTool", () => {
  const allToolNames = ["read", "write", "exec", "email", "calendar", "web_search"];
  const coreToolNames = new Set(["read", "write", "exec"]);

  const getDetails = (result: { details?: unknown }) => result.details as Record<string, unknown>;

  it("calls onLoad with validated tool names", async () => {
    const onLoad = vi.fn();
    const tool = createToolLoadTool({ allToolNames, coreToolNames, onLoad });

    const result = await tool.execute("call-1", { tools: "email,calendar" });
    expect(onLoad).toHaveBeenCalledWith(["email", "calendar"]);
    expect(getDetails(result).loaded).toEqual(["email", "calendar"]);
  });

  it("reports already-loaded core tools", async () => {
    const onLoad = vi.fn();
    const tool = createToolLoadTool({ allToolNames, coreToolNames, onLoad });

    const result = await tool.execute("call-2", { tools: "read,email" });
    expect(onLoad).toHaveBeenCalledWith(["email"]);
    expect(getDetails(result).alreadyLoaded).toEqual(["read"]);
    expect(getDetails(result).loaded).toEqual(["email"]);
  });

  it("reports unknown tool names", async () => {
    const onLoad = vi.fn();
    const tool = createToolLoadTool({ allToolNames, coreToolNames, onLoad });

    const result = await tool.execute("call-3", { tools: "nonexistent" });
    expect(onLoad).not.toHaveBeenCalled();
    expect(getDetails(result).unknown).toEqual(["nonexistent"]);
  });

  it("throws when tools param is empty", async () => {
    const onLoad = vi.fn();
    const tool = createToolLoadTool({ allToolNames, coreToolNames, onLoad });

    await expect(tool.execute("call-4", { tools: "" })).rejects.toThrow("tools required");
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("is case-insensitive for tool name matching", async () => {
    const onLoad = vi.fn();
    const tool = createToolLoadTool({ allToolNames, coreToolNames, onLoad });

    const result = await tool.execute("call-5", { tools: "EMAIL,Web_Search" });
    expect(onLoad).toHaveBeenCalledWith(["email", "web_search"]);
    expect(getDetails(result).loaded).toEqual(["email", "web_search"]);
  });
});
