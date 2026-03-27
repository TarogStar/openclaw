import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

const textToSpeechMock = vi.hoisted(() => vi.fn());

vi.mock("../../tts/tts.js", () => ({
  textToSpeech: textToSpeechMock,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

let createTtsTool: typeof import("./tts-tool.js").createTtsTool;

async function loadModule() {
  vi.resetModules();
  vi.doMock("../../tts/tts.js", () => ({
    textToSpeech: textToSpeechMock,
  }));
  vi.doMock("../../config/config.js", () => ({
    loadConfig: () => ({}),
  }));
  ({ createTtsTool } = await import("./tts-tool.js"));
}

describe("createTtsTool", () => {
  beforeEach(async () => {
    textToSpeechMock.mockReset();
    await loadModule();
  });

  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain(SILENT_REPLY_TOKEN);
    expect(typeof SILENT_REPLY_TOKEN).toBe("string");
    expect(SILENT_REPLY_TOKEN.length).toBeGreaterThan(0);
  });

  it("stores audio delivery in details.media", async () => {
    textToSpeechMock.mockResolvedValue({
      success: true,
      audioPath: "/tmp/reply.opus",
      provider: "test",
      voiceCompatible: true,
    });

    const tool = createTtsTool();
    const result = await tool.execute("call-1", { text: "hello" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Generated audio reply." }],
      details: {
        audioPath: "/tmp/reply.opus",
        provider: "test",
        media: {
          mediaUrl: "/tmp/reply.opus",
          audioAsVoice: true,
        },
      },
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });
});
