import { describe, expect, it } from "vitest";
import { getPluginStreamFn, registerPluginStreamFn } from "./stream-fn-registry.js";

describe("stream-fn-registry", () => {
  it("returns null for unregistered api type", () => {
    expect(getPluginStreamFn("nonexistent")).toBeNull();
  });

  it("registers and retrieves a stream function", () => {
    const mockStreamFn = () => ({}) as never;
    registerPluginStreamFn("test-api", mockStreamFn);
    expect(getPluginStreamFn("test-api")).toBe(mockStreamFn);
  });

  it("overwrites a previously registered stream function", () => {
    const first = () => ({}) as never;
    const second = () => ({}) as never;
    registerPluginStreamFn("overwrite-api", first);
    registerPluginStreamFn("overwrite-api", second);
    expect(getPluginStreamFn("overwrite-api")).toBe(second);
  });
});
