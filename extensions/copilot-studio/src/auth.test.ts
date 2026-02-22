import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so they're available before module imports
const mockAllAccounts = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockAcquireTokenSilent = vi.hoisted(() => vi.fn());
const mockAcquireTokenByDeviceCode = vi.hoisted(() => vi.fn());
const mockGetTokenCache = vi.hoisted(() =>
  vi.fn().mockReturnValue({ getAllAccounts: mockAllAccounts }),
);

vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    acquireTokenSilent = mockAcquireTokenSilent;
    acquireTokenByDeviceCode = mockAcquireTokenByDeviceCode;
    getTokenCache = mockGetTokenCache;
    constructor() {
      // Ignore config
    }
  },
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

import { CopilotStudioAuth, DeviceCodeRequiredError } from "./auth.js";

function createAuth() {
  return new CopilotStudioAuth(
    { clientId: "test-client", tenantId: "test-tenant", scopes: ["scope1"] },
    () => {},
  );
}

describe("CopilotStudioAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAllAccounts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getToken with cached token", () => {
    it("returns accessToken from silent acquisition", async () => {
      const account = { homeAccountId: "acc-1", environment: "login", tenantId: "t" };
      mockAllAccounts.mockResolvedValue([account]);
      mockAcquireTokenSilent.mockResolvedValue({ accessToken: "cached-token-123" });

      const auth = createAuth();
      const token = await auth.getToken();
      expect(token).toBe("cached-token-123");
      expect(mockAcquireTokenSilent).toHaveBeenCalledWith({
        account,
        scopes: ["scope1"],
      });
    });
  });

  describe("getToken device code flow", () => {
    it("throws DeviceCodeRequiredError when callback fires", async () => {
      mockAcquireTokenByDeviceCode.mockImplementation(
        (params: { deviceCodeCallback: (r: Record<string, string>) => void }) => {
          // Call the callback synchronously (simulating MSAL behavior)
          params.deviceCodeCallback({
            userCode: "ABC123",
            verificationUri: "https://microsoft.com/devicelogin",
            message: "Go to https://microsoft.com/devicelogin and enter code ABC123",
          });
          // Return a promise that never resolves (user hasn't authenticated yet)
          return new Promise(() => {});
        },
      );

      const auth = createAuth();
      await expect(auth.getToken()).rejects.toThrow(DeviceCodeRequiredError);
    });

    it("includes correct fields on DeviceCodeRequiredError", async () => {
      mockAcquireTokenByDeviceCode.mockImplementation(
        (params: { deviceCodeCallback: (r: Record<string, string>) => void }) => {
          params.deviceCodeCallback({
            userCode: "XYZ789",
            verificationUri: "https://example.com/auth",
            message: "Enter code XYZ789",
          });
          return new Promise(() => {});
        },
      );

      const auth = createAuth();
      try {
        await auth.getToken();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeRequiredError);
        const dce = err as DeviceCodeRequiredError;
        expect(dce.userCode).toBe("XYZ789");
        expect(dce.verificationUri).toBe("https://example.com/auth");
        expect(dce.userMessage).toBe("Enter code XYZ789");
      }
    });
  });

  describe("getToken with pending flow", () => {
    it("returns pending promise on second call", async () => {
      let resolveToken: ((result: { accessToken: string }) => void) | null = null;

      mockAcquireTokenByDeviceCode.mockImplementation(
        (params: { deviceCodeCallback: (r: Record<string, string>) => void }) => {
          params.deviceCodeCallback({
            userCode: "CODE1",
            verificationUri: "https://example.com",
            message: "msg",
          });
          return new Promise((resolve) => {
            resolveToken = resolve;
          });
        },
      );

      const auth = createAuth();

      // First call throws DeviceCodeRequiredError
      await expect(auth.getToken()).rejects.toThrow(DeviceCodeRequiredError);

      // Second call should return the pending promise (not throw again)
      const tokenPromise = auth.getToken();

      // Resolve the device code flow
      resolveToken!({ accessToken: "new-token" });

      const token = await tokenPromise;
      expect(token).toBe("new-token");
    });
  });

  describe("token race (token resolves before callback)", () => {
    it("returns token directly when MSAL resolves immediately", async () => {
      // Simulate MSAL resolving the token without ever calling deviceCodeCallback
      // (edge case: cached token found during device code init)
      mockAcquireTokenByDeviceCode.mockResolvedValue({ accessToken: "instant-token" });

      const auth = createAuth();
      const token = await auth.getToken();
      expect(token).toBe("instant-token");
    });
  });

  describe("silent refresh failure falls through to device code", () => {
    it("starts device code flow when silent acquisition fails", async () => {
      const account = { homeAccountId: "acc-1", environment: "login", tenantId: "t" };
      mockAllAccounts.mockResolvedValue([account]);
      mockAcquireTokenSilent.mockRejectedValue(new Error("token expired"));

      mockAcquireTokenByDeviceCode.mockImplementation(
        (params: { deviceCodeCallback: (r: Record<string, string>) => void }) => {
          params.deviceCodeCallback({
            userCode: "FALLBACK",
            verificationUri: "https://example.com/auth",
            message: "msg",
          });
          return new Promise(() => {});
        },
      );

      const auth = createAuth();
      await expect(auth.getToken()).rejects.toThrow(DeviceCodeRequiredError);
    });
  });

  describe("device code flow error propagation", () => {
    it("resets after MSAL rejection so next call starts fresh", async () => {
      let callCount = 0;
      mockAcquireTokenByDeviceCode.mockImplementation(
        (params: { deviceCodeCallback: (r: Record<string, string>) => void }) => {
          callCount++;
          params.deviceCodeCallback({
            userCode: `CODE${callCount}`,
            verificationUri: "https://example.com",
            message: "msg",
          });
          return Promise.reject(new Error("auth timed out"));
        },
      );

      const auth = createAuth();

      // First call: callback fires, throws DeviceCodeRequiredError
      await expect(auth.getToken()).rejects.toThrow(DeviceCodeRequiredError);
      expect(callCount).toBe(1);

      // Allow the .catch() microtask to run and reset pendingDeviceCode
      await new Promise((r) => setTimeout(r, 0));

      // Second call: fresh device code flow starts (not the rejected promise)
      await expect(auth.getToken()).rejects.toThrow(DeviceCodeRequiredError);
      expect(callCount).toBe(2);
    });
  });
});

describe("DeviceCodeRequiredError", () => {
  it("has correct name and fields", () => {
    const err = new DeviceCodeRequiredError({
      userCode: "CODE",
      verificationUri: "https://example.com",
      message: "Go to URL",
    });
    expect(err.name).toBe("DeviceCodeRequiredError");
    expect(err.userCode).toBe("CODE");
    expect(err.verificationUri).toBe("https://example.com");
    expect(err.userMessage).toBe("Go to URL");
    expect(err.message).toBe("Authentication required — device code flow pending");
  });
});
