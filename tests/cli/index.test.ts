import { describe, expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "../../src/cli/index.js";
import type { WrapperInstallResult, WrapperLauncher } from "../../src/core/wrapper.js";

type TestCliDependencies = CliDependencies & { __writes: string[] };

function makeDependencies(overrides: Partial<CliDependencies> = {}): TestCliDependencies {
  const writes: string[] = [];
  const wrapperResult: WrapperInstallResult = {
    wrapperPath: "/tmp/codex-router/bin/codex",
    realCodexPath: "/usr/local/bin/codex",
    pathHint: "export PATH='/tmp/codex-router/bin':$PATH",
  };
  const launcher: WrapperLauncher = {
    kind: "command",
    command: "codex-router",
  };

  return {
    createService: () => ({
      initWrapper: vi.fn(async () => wrapperResult),
      login: vi.fn(async (tag: string) => ({
        tag,
        authStoragePath: `/tmp/${tag}/auth.json`,
        authState: "ready" as const,
        createdAt: new Date().toISOString(),
      })),
      runSelectedCodex: vi.fn(async () => 0),
      switchTo: vi.fn(async (tag: string) => ({
        tag,
        authStoragePath: `/tmp/${tag}/auth.json`,
        authState: "ready" as const,
        createdAt: new Date().toISOString(),
      })),
      current: vi.fn(async () => ({
        tag: "codex-2",
        authStoragePath: "/tmp/codex-2/auth.json",
        authState: "ready" as const,
        createdAt: new Date().toISOString(),
      })),
      deleteTag: vi.fn(async () => {}),
      importDefaultCodexHome: vi.fn(async () => {}),
      statusAll: vi.fn(async () => [
        {
          tag: "codex-1",
          active: true,
          authState: "ready" as const,
          authStoragePath: "/tmp/codex-1/auth.json",
          snapshot: {
            fiveHourUsedPct: 68,
            weeklyUsedPct: 41,
            resetIn: "14m",
            rawLimitSource: "structured token_count event",
          },
        },
      ]),
      statusForTag: vi.fn(async (tag: string) => ({
        tag,
        active: true,
        authState: "ready" as const,
        authStoragePath: `/tmp/${tag}/auth.json`,
        snapshot: {
          fiveHourUsedPct: 17,
          weeklyUsedPct: 66,
          resetIn: "44m",
          rawLimitSource: "structured token_count event",
        },
      })),
    }),
    cwd: "/tmp/project",
    detectLauncher: () => launcher,
    pathValue: "/usr/local/bin:/usr/bin",
    routerHome: "/tmp/codex-router",
    updateShellProfile: vi.fn(async () => ({
      changed: true,
      profilePath: "/tmp/.zshrc",
      reloadCommand: "source ~/.zshrc",
    })),
    writeStdout: (value: string) => writes.push(value),
    writeStderr: (value: string) => writes.push(value),
    ...overrides,
    __writes: writes,
  };
}

describe("CLI", () => {
  test("prints the active tag for current", async () => {
    const deps = makeDependencies();

    const exitCode = await runCli(["current"], deps);

    expect(exitCode).toBe(0);
    expect(deps.__writes.join("")).toContain("codex-2");
  });

  test("prints the usage-first table for status", async () => {
    const deps = makeDependencies();

    const exitCode = await runCli(["status"], deps);

    expect(exitCode).toBe(0);
    const output = deps.__writes.join("");
    expect(output).toContain("5H_USED");
    expect(output).toContain("WEEKLY_USED");
    expect(output).toContain("68%");
    expect(output).toContain("41%");
  });

  test("prints single-tag detail for status -t", async () => {
    const deps = makeDependencies();

    const exitCode = await runCli(["status", "-t", "codex-1"], deps);

    expect(exitCode).toBe(0);
    const output = deps.__writes.join("");
    expect(output).toContain("tag: codex-1");
    expect(output).toContain("five_hour_used_pct: 17%");
    expect(output).toContain("weekly_used_pct: 66%");
  });

  test("prints wrapper installation instructions for init", async () => {
    const deps = makeDependencies();

    const exitCode = await runCli(["init"], deps);

    expect(exitCode).toBe(0);
    const output = deps.__writes.join("");
    expect(output).toContain("Installed codex wrapper");
    expect(output).toContain("Real codex binary");
    expect(output).toMatch(/(Updated|Verified) shell profile|Add to your shell profile/);
  });
});
