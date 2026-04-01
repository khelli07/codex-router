import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createRouterService } from "../../src/core/service.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-router-service-"));
  tempDirs.push(dir);
  return dir;
}

async function prepareFakeCodexHome(): Promise<string> {
  const fakeHome = await makeTempDir();
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  return fakeHome;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("router service", () => {
  test("logs in a tagged account and persists its auth slot", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      appServerRequester: async ({ method }) => {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: "codex-1@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
      runner: async (_command, args, options) => {
        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    const account = await service.login("codex-1");
    expect(account.tag).toBe("codex-1");
    expect(account.accountIdentity).toBe("codex-1@example.com");

    const authFile = await readFile(path.join(routerHome, "accounts", "codex-1", "auth.json"), "utf8");
    expect(authFile).toContain("token");
  });

  test("seeds shared state from the default Codex home on first tagged login", async () => {
    const fakeHome = await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const defaultCodexHome = path.join(fakeHome, ".codex");

    await rm(routerHome, { force: true, recursive: true });
    await writeFile(path.join(defaultCodexHome, "config.toml"), "model = \"gpt-5.4\"\n", "utf8");
    await mkdir(path.join(defaultCodexHome, "skills", ".system"), { recursive: true });
    await writeFile(path.join(defaultCodexHome, "skills", ".system", "keep.txt"), "skill\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "auth.json"), "{\"do\":\"not-copy\"}\n", "utf8");

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      appServerRequester: async ({ method }) => {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: "codex-1@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
      runner: async (_command, args, options) => {
        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");

    await expect(readFile(path.join(routerHome, "shared", "config.toml"), "utf8")).resolves.toContain(
      "gpt-5.4",
    );
    await expect(readFile(path.join(routerHome, "shared", "skills", ".system", "keep.txt"), "utf8")).resolves.toContain(
      "skill",
    );
    await expect(stat(path.join(routerHome, "shared", "auth.json"))).rejects.toThrow();
  });

  test("refreshes a tag status and stores live 5-hour and weekly percentages", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      appServerRequester: async ({ method }) => {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: "codex-1@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        }

        if (method === "account/rateLimits/read") {
          return {
            rateLimits: {
              primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_775_000_840 },
              secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: 1_775_598_000 },
              planType: "plus",
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
      runner: async (_command, args, options) => {
        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
          return { exitCode: 0, stderr: "", stdout: "" };
        }

        if (args[0] === "login" && args[1] === "status") {
          return { exitCode: 0, stderr: "", stdout: "" };
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    const status = await service.statusForTag("codex-1");

    expect(status.tag).toBe("codex-1");
    expect(status.accountIdentity).toBe("codex-1@example.com");
    expect(status.snapshot.fiveHourUsedPct).toBe(22);
    expect(status.snapshot.weeklyUsedPct).toBe(71);

    const allStatuses = await service.statusAll();
    expect(allStatuses[0]?.snapshot.fiveHourUsedPct).toBe(22);
  });

  test("switches active tag before launch and uses the active account auth", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const invocations: Array<{ args: string[]; codexHome: string | undefined }> = [];

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      appServerRequester: async ({ method, codexHomeDir }) => {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: path.basename(codexHomeDir) === "codex-1" ? "codex-1@example.com" : "codex-2@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
      runner: async (_command, args, options) => {
        invocations.push({ args, codexHome: options.env.CODEX_HOME });

        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    await service.login("codex-2");
    await service.switchTo("codex-2");
    await service.launch();

    const launchInvocation = invocations.at(-1);
    expect(launchInvocation?.args).toEqual([]);
    expect(launchInvocation?.codexHome).toBe(path.join(routerHome, "runtime", "current-home"));
  });
});
