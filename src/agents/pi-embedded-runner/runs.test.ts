import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  consumeEmbeddedRunModelSwitch,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunStreaming,
  requestEmbeddedRunModelSwitch,
  setActiveEmbeddedRun,
  touchStreamingActivity,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: { isCompacting?: boolean; abort?: () => void } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => overrides.isCompacting ?? false,
    abort,
  };
}

describe("pi-embedded runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun(
      "session-compacting",
      createRunHandle({ isCompacting: true, abort: abortCompacting }),
    );

    setActiveEmbeddedRun("session-normal", createRunHandle({ abort: abortNormal }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", createRunHandle({ isCompacting: true, abort: abortA }));

    setActiveEmbeddedRun("session-b", createRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", createRunHandle());

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = createRunHandle();

    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedPiRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedPiRunActive("session-shared")).toBe(false);
    } finally {
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });

  it("stores and consumes pending live model switch requests", () => {
    expect(
      requestEmbeddedRunModelSwitch("session-switch", {
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toBe(true);

    expect(consumeEmbeddedRunModelSwitch("session-switch")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(consumeEmbeddedRunModelSwitch("session-switch")).toBeUndefined();
  });

  it("drops pending live model switch requests when the run clears", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-clear-switch", handle);
    requestEmbeddedRunModelSwitch("session-clear-switch", {
      provider: "openai",
      model: "gpt-5.4",
    });

    clearActiveEmbeddedRun("session-clear-switch", handle);

    expect(consumeEmbeddedRunModelSwitch("session-clear-switch")).toBeUndefined();
  });

  describe("streaming activity tracking", () => {
    it("reports streaming when activity is fresh", () => {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-fresh", handle);

      // setActiveEmbeddedRun initializes the timestamp
      expect(isEmbeddedPiRunStreaming("session-fresh")).toBe(true);
    });

    it("touchStreamingActivity refreshes the staleness timestamp", () => {
      vi.useFakeTimers();
      try {
        const handle = createRunHandle();
        setActiveEmbeddedRun("session-touch", handle);

        // Advance close to (but not past) the threshold
        vi.advanceTimersByTime(__testing.STREAMING_STALENESS_THRESHOLD_MS - 1_000);
        touchStreamingActivity("session-touch");

        // Advance another threshold minus a bit — would be stale without the touch
        vi.advanceTimersByTime(__testing.STREAMING_STALENESS_THRESHOLD_MS - 1_000);
        expect(isEmbeddedPiRunStreaming("session-touch")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("force-ends streaming when activity exceeds staleness threshold", () => {
      vi.useFakeTimers();
      try {
        const forceEnd = vi.fn();
        const handle = createRunHandle();
        handle.forceEndStreaming = forceEnd;
        setActiveEmbeddedRun("session-stale", handle);

        vi.advanceTimersByTime(__testing.STREAMING_STALENESS_THRESHOLD_MS + 1);

        expect(isEmbeddedPiRunStreaming("session-stale")).toBe(false);
        expect(forceEnd).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up tracking maps after force-ending a stale stream", () => {
      vi.useFakeTimers();
      try {
        const handle = createRunHandle();
        handle.forceEndStreaming = vi.fn();
        setActiveEmbeddedRun("session-cleanup", handle);

        vi.advanceTimersByTime(__testing.STREAMING_STALENESS_THRESHOLD_MS + 1);
        isEmbeddedPiRunStreaming("session-cleanup");

        // Run is no longer active after force-end cleanup
        expect(isEmbeddedPiRunStreaming("session-cleanup")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not force-end when handle has no forceEndStreaming", () => {
      vi.useFakeTimers();
      try {
        const handle = createRunHandle();
        // no forceEndStreaming set — uses optional chaining
        setActiveEmbeddedRun("session-no-force", handle);

        vi.advanceTimersByTime(__testing.STREAMING_STALENESS_THRESHOLD_MS + 1);

        // Should still return false (stale) but not throw
        expect(isEmbeddedPiRunStreaming("session-no-force")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
