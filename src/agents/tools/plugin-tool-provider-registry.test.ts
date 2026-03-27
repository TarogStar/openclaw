import { describe, expect, it } from "vitest";
import {
  getPluginToolProvider,
  registerPluginToolProvider,
} from "./plugin-tool-provider-registry.js";

describe("plugin-tool-provider-registry", () => {
  it("returns null for unregistered provider", () => {
    expect(getPluginToolProvider("web_search", "nonexistent")).toBeNull();
  });

  it("registers and retrieves a tool provider", () => {
    const mockFn = async () => ({ content: "test" });
    registerPluginToolProvider("web_search", "test-provider", mockFn);
    expect(getPluginToolProvider("web_search", "test-provider")).toBe(mockFn);
  });

  it("distinguishes providers by tool id and provider id", () => {
    const emailFn = async () => ({ content: "email" });
    const calendarFn = async () => ({ content: "calendar" });
    registerPluginToolProvider("email", "cs", emailFn);
    registerPluginToolProvider("calendar", "cs", calendarFn);
    expect(getPluginToolProvider("email", "cs")).toBe(emailFn);
    expect(getPluginToolProvider("calendar", "cs")).toBe(calendarFn);
  });

  it("overwrites a previously registered provider", () => {
    const first = async () => ({ content: "first" });
    const second = async () => ({ content: "second" });
    registerPluginToolProvider("email", "overwrite", first);
    registerPluginToolProvider("email", "overwrite", second);
    expect(getPluginToolProvider("email", "overwrite")).toBe(second);
  });
});
