import fs from "node:fs";
import path from "node:path";
import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-node";

const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw");
const CACHE_PATH = path.join(CACHE_DIR, "copilot-studio-token-cache.json");

export type CopilotStudioAuthConfig = {
  clientId: string;
  tenantId: string;
  scopes: string[];
};

/**
 * Thrown when device code auth is needed. Contains the user-facing message
 * with the URL and code so it can be relayed through the tool result.
 */
export class DeviceCodeRequiredError extends Error {
  public readonly userCode: string;
  public readonly verificationUri: string;
  public readonly userMessage: string;

  constructor(params: { userCode: string; verificationUri: string; message: string }) {
    super("Authentication required — device code flow pending");
    this.name = "DeviceCodeRequiredError";
    this.userCode = params.userCode;
    this.verificationUri = params.verificationUri;
    this.userMessage = params.message;
  }
}

export class CopilotStudioAuth {
  private pca: PublicClientApplication;
  private scopes: string[];
  private log: (msg: string) => void;
  private pendingDeviceCode: Promise<string> | null = null;

  constructor(config: CopilotStudioAuthConfig, log?: (msg: string) => void) {
    this.scopes = config.scopes;
    this.log = log ?? console.log;

    this.pca = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (ctx) => {
            try {
              const data = fs.readFileSync(CACHE_PATH, "utf8");
              ctx.tokenCache.deserialize(data);
            } catch {
              // No cache file yet — that's fine
            }
          },
          afterCacheAccess: async (ctx) => {
            if (ctx.cacheHasChanged) {
              fs.mkdirSync(CACHE_DIR, { recursive: true });
              fs.writeFileSync(CACHE_PATH, ctx.tokenCache.serialize());
            }
          },
        },
      },
    });
  }

  /**
   * Get a valid access token. Tries silent refresh first.
   * If no cached token exists, throws DeviceCodeRequiredError with the auth URL/code
   * so the caller can relay it to the user. Call `waitForDeviceCode()` after the user
   * has been notified.
   */
  async getToken(): Promise<string> {
    // If there's a pending device code flow, wait for it
    if (this.pendingDeviceCode) {
      return this.pendingDeviceCode;
    }

    // Try silent acquisition from cached refresh token
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
      const result = await this.trySilent(accounts[0]);
      if (result) {
        return result.accessToken;
      }
    }

    // No cached token — start device code flow and throw with the auth details
    return this.startDeviceCodeFlow();
  }

  private async trySilent(account: AccountInfo): Promise<AuthenticationResult | null> {
    try {
      return await this.pca.acquireTokenSilent({
        account,
        scopes: this.scopes,
      });
    } catch {
      return null;
    }
  }

  /**
   * Starts the device code flow. On first call, throws DeviceCodeRequiredError
   * with the URL/code. The flow continues in the background — the next call
   * to getToken() will await the pending result.
   */
  private async startDeviceCodeFlow(): Promise<string> {
    this.log("[copilot-studio] Starting device code authentication...");

    let resolveCode: ((token: string) => void) | null = null;
    let rejectCode: ((err: Error) => void) | null = null;

    this.pendingDeviceCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    // Resolves as soon as MSAL calls the deviceCodeCallback
    type DeviceCodeInfo = { userCode: string; verificationUri: string; message: string };
    let resolveDeviceCode: ((info: DeviceCodeInfo) => void) | null = null;
    const deviceCodeReady = new Promise<DeviceCodeInfo>((resolve) => {
      resolveDeviceCode = resolve;
    });

    // Fire and forget — the promise resolves when user completes auth
    this.pca
      .acquireTokenByDeviceCode({
        scopes: this.scopes,
        deviceCodeCallback: (response) => {
          this.log(`[copilot-studio] ${response.message}`);
          resolveDeviceCode!({
            userCode: response.userCode,
            verificationUri: response.verificationUri,
            message: response.message,
          });
        },
      })
      .then((result) => {
        this.pendingDeviceCode = null;
        if (result) {
          this.log("[copilot-studio] Authentication successful");
          resolveCode!(result.accessToken);
        } else {
          rejectCode!(new Error("Device code authentication returned no result"));
        }
      })
      .catch((err) => {
        this.pendingDeviceCode = null;
        rejectCode!(err);
      });

    // Race: either deviceCodeCallback fires (normal path) or the full
    // token resolves first (e.g. cached token that MSAL picked up late)
    const winner = await Promise.race([
      deviceCodeReady.then((info) => ({ kind: "device-code" as const, info })),
      this.pendingDeviceCode.then((token) => ({ kind: "token" as const, token })),
    ]);

    if (winner.kind === "token") {
      return winner.token;
    }

    // Throw so the tool can return the auth URL to the user
    throw new DeviceCodeRequiredError(winner.info);
  }
}
