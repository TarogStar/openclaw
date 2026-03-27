import { afterEach, describe, expect, it, vi } from "vitest";
import * as fetchGuard from "../../infra/net/fetch-guard.js";
import { withStrictWebToolsEndpoint, withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";

describe("web-guarded-fetch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.clearAllMocks();
  });

  it("uses trusted SSRF policy for trusted web tools endpoints", async () => {
    fetchSpy = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchGuard.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        policy: expect.objectContaining({
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        }),
        mode: fetchGuard.GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps strict endpoint policy unchanged", async () => {
    fetchSpy = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchGuard.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
      }),
    );
    const call = vi.mocked(fetchGuard.fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(call?.policy).toBeUndefined();
    expect(call?.mode).toBe(fetchGuard.GUARDED_FETCH_MODE.STRICT);
  });
});
