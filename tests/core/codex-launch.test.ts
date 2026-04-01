import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { launchCodex, probeAccountLimits } from "../../src/core/codex.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-router-launch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Codex process orchestration", () => {
  test("launches Codex with resume when shared sessions already exist", async () => {
    const runtimeHomeDir = await makeTempDir();
    await mkdir(path.join(runtimeHomeDir, "sessions"), { recursive: true });
    await writeFile(path.join(runtimeHomeDir, "sessions", "session.jsonl"), "{}\n", "utf8");

    const invocations: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    await launchCodex({
      runtimeHomeDir,
      cwd: "/tmp/project",
      runner: async (command, args, options) => {
        invocations.push({ command, args, env: options.env });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe("codex");
    expect(invocations[0]?.args).toEqual(["resume", "--last", "--all"]);
    expect(invocations[0]?.env.CODEX_HOME).toBe(runtimeHomeDir);
  });

  test("launches a fresh Codex session when there is nothing to resume", async () => {
    const runtimeHomeDir = await makeTempDir();

    const invocations: Array<{ command: string; args: string[] }> = [];

    await launchCodex({
      runtimeHomeDir,
      cwd: "/tmp/project",
      runner: async (command, args) => {
        invocations.push({ command, args });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe("codex");
    expect(invocations[0]?.args).toEqual([]);
  });

  test("probes live limits under the selected runtime home", async () => {
    const runtimeHomeDir = await makeTempDir();
    const invocations: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    const snapshot = await probeAccountLimits({
      codexHomeDir: runtimeHomeDir,
      cwd: "/tmp/project",
      runner: async (command, args, options) => {
        invocations.push({ command, args, env: options.env });
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 17, window_minutes: 300, resets_at: 1_775_000_840 },
              secondary: { used_percent: 66, window_minutes: 10_080, resets_at: 1_775_598_000 },
              plan_type: "plus",
            },
          }),
        };
      },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe("codex");
    expect(invocations[0]?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "Reply with OK only.",
    ]);
    expect(invocations[0]?.env.CODEX_HOME).toBe(runtimeHomeDir);
    expect(snapshot.fiveHourUsedPct).toBe(17);
    expect(snapshot.weeklyUsedPct).toBe(66);
  });
});
