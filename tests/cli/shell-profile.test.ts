import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { updateShellProfile } from "../../src/cli/shell-profile.js";

const tempDirs: string[] = [];
let savedShell: string | undefined;

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-router-shell-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedShell = process.env.SHELL;
});

afterEach(async () => {
  if (savedShell === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = savedShell;
  }
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("shell profile setup", () => {
  test("writes a managed zsh PATH block", async () => {
    const homeDir = await makeTempHome();
    process.env.SHELL = "/bin/zsh";
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const result = await updateShellProfile(path.join(homeDir, ".codex-router", "bin"));
    expect(result.changed).toBe(true);
    expect(result.profilePath).toBe(path.join(homeDir, ".zshrc"));

    const content = await readFile(path.join(homeDir, ".zshrc"), "utf8");
    expect(content).toContain("# >>> codex-router >>>");
    expect(content).toContain(`export PATH="${path.join(homeDir, ".codex-router", "bin")}:$PATH"`);
  });

  test("is idempotent when the managed block already exists", async () => {
    const homeDir = await makeTempHome();
    process.env.SHELL = "/bin/zsh";
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    await updateShellProfile(path.join(homeDir, ".codex-router", "bin"));
    const result = await updateShellProfile(path.join(homeDir, ".codex-router", "bin"));
    expect(result.changed).toBe(false);
  });
});
