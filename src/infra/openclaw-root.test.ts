import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const VITEST_FS_BASE = path.join(path.parse(process.cwd()).root, "__openclaw_vitest__");
const FIXTURE_BASE = path.join(VITEST_FS_BASE, "openclaw-root");

const entries = new Map<string, FakeFsEntry>();
const realpaths = new Map<string, string>();
const realpathErrors = new Set<string>();

const abs = (p: string) => path.resolve(p);
const fx = (...parts: string[]) => path.join(FIXTURE_BASE, ...parts);
const vitestRootWithSep = `${abs(VITEST_FS_BASE)}${path.sep}`;
const isFixturePath = (p: string) => {
  const resolved = abs(p);
  return resolved === vitestRootWithSep.slice(0, -1) || resolved.startsWith(vitestRootWithSep);
};

function setFile(p: string, content = "") {
  entries.set(abs(p), { kind: "file", content });
}

// Use vi.spyOn instead of vi.mock so the interception applies to every module
// that holds a reference to the real node:fs / node:fs/promises objects
// (vi.mock in vitest 4 + pool:"forks" does not reliably intercept node: builtins
// for modules that captured the binding at import time).

const origReadFileSync = fsSync.readFileSync;
const origRealpathSync = fsSync.realpathSync;
const origReadFile = fsPromises.readFile;

describe("resolveOpenClawPackageRoot", () => {
  beforeEach(() => {
    entries.clear();
    realpaths.clear();
    realpathErrors.clear();

    vi.spyOn(fsSync, "readFileSync").mockImplementation((p: unknown, encoding?: unknown) => {
      const pStr = String(p);
      if (!isFixturePath(pStr)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origReadFileSync(p as any, encoding as any) as any;
      }
      const entry = entries.get(abs(pStr));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${pStr}'`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (encoding ? entry.content : Buffer.from(entry.content, "utf-8")) as any;
    });

    vi.spyOn(fsSync, "realpathSync").mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (!isFixturePath(pStr)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origRealpathSync(p as any) as any;
      }
      const resolved = abs(pStr);
      if (realpathErrors.has(resolved)) {
        throw new Error(`ENOENT: no such file or directory, realpath '${pStr}'`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realpaths.get(resolved) ?? resolved) as any;
    });

    vi.spyOn(fsPromises, "readFile").mockImplementation(async (p: unknown, encoding?: unknown) => {
      const pStr = String(p);
      if (!isFixturePath(pStr)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origReadFile(p as any, encoding as any) as any;
      }
      const entry = entries.get(abs(pStr));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${pStr}'`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return entry.content as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves package root from .bin argv1", () => {
    const project = fx("bin-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
    const pkgRoot = path.join(project, "node_modules", "openclaw");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));

    expect(resolveOpenClawPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("resolves package root via symlinked argv1", () => {
    const project = fx("symlink-scenario");
    const bin = path.join(project, "bin", "openclaw");
    const realPkg = path.join(project, "real-pkg");
    realpaths.set(abs(bin), abs(path.join(realPkg, "openclaw.mjs")));
    setFile(path.join(realPkg, "package.json"), JSON.stringify({ name: "openclaw" }));

    expect(resolveOpenClawPackageRootSync({ argv1: bin })).toBe(realPkg);
  });

  it("falls back when argv1 realpath throws", () => {
    const project = fx("realpath-throw-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
    const pkgRoot = path.join(project, "node_modules", "openclaw");
    realpathErrors.add(abs(argv1));
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));

    expect(resolveOpenClawPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("prefers moduleUrl candidates", () => {
    const pkgRoot = fx("moduleurl");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "index.js")).toString();

    expect(resolveOpenClawPackageRootSync({ moduleUrl })).toBe(pkgRoot);
  });

  it("returns null for non-openclaw package roots", () => {
    const pkgRoot = fx("not-openclaw");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "not-openclaw" }));

    expect(resolveOpenClawPackageRootSync({ cwd: pkgRoot })).toBeNull();
  });

  it("async resolver matches sync behavior", async () => {
    const pkgRoot = fx("async");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));

    await expect(resolveOpenClawPackageRoot({ cwd: pkgRoot })).resolves.toBe(pkgRoot);
  });

  it("async resolver returns null when no package roots exist", async () => {
    await expect(resolveOpenClawPackageRoot({ cwd: fx("missing") })).resolves.toBeNull();
  });
});
