import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRouterService } from "../../src/core/service.js";

const tempDirs: string[] = [];
let savedCodexRouterRealCodex: string | undefined;

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

beforeEach(() => {
  savedCodexRouterRealCodex = process.env.CODEX_ROUTER_REAL_CODEX;
  delete process.env.CODEX_ROUTER_REAL_CODEX;
});

afterEach(async () => {
  if (savedCodexRouterRealCodex === undefined) {
    delete process.env.CODEX_ROUTER_REAL_CODEX;
  } else {
    process.env.CODEX_ROUTER_REAL_CODEX = savedCodexRouterRealCodex;
  }
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

  test("rejects tags that escape the managed accounts directory", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      runner: async () => {
        throw new Error("runner should not be called for invalid tags");
      },
    });

    await expect(service.login("../escape")).rejects.toThrow(/invalid account tag/i);
    await expect(service.login("/tmp/escape")).rejects.toThrow(/invalid account tag/i);
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

  test("mirrors default codex state on tagged login when shared state already exists", async () => {
    const fakeHome = await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const defaultCodexHome = path.join(fakeHome, ".codex");

    await mkdir(path.join(routerHome, "shared"), { recursive: true });
    await writeFile(path.join(routerHome, "shared", "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    await writeFile(path.join(routerHome, "shared", "history.jsonl"), "[]\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

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
      'model = "gpt-5.5"',
    );
    await expect(readFile(path.join(routerHome, "shared", "history.jsonl"), "utf8")).rejects.toThrow();
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
    expect(status.snapshot.weeklyResetIn).toBeTruthy();

    const allStatuses = await service.statusAll();
    expect(allStatuses[0]?.snapshot.fiveHourUsedPct).toBe(22);
    expect(allStatuses[0]?.snapshot.weeklyResetIn).toBeTruthy();
  });

  test("records a status check timestamp even when the account needs login", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      runner: async (_command, args, options) => {
        if (args[0] === "login" && args[1] === "status") {
          return { exitCode: 1, stderr: "not logged in", stdout: "" };
        }

        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    const status = await service.statusForTag("codex-1");

    expect(status.authState).toBe("needs_login");
    expect(status.lastStatusCheckAt).toBeTruthy();
  });

  test("switches the active tag without mutating the default codex home", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();

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
        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), "{\"token\":true}\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    await service.login("codex-2");
    const active = await service.switchTo("codex-2");

    expect(active.tag).toBe("codex-2");
  });

  test("installs a codex wrapper that preserves the real binary path", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const binDir = await makeTempDir();
    const realCodexPath = path.join(binDir, "codex");
    await writeFile(realCodexPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(realCodexPath, 0o755);

    const service = createRouterService({
      routerHome,
      workspaceCwd: "/tmp/project",
      pathValue: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    const result = await service.initWrapper({
      kind: "node",
      nodePath: "/usr/bin/node",
      scriptPath: "/tmp/codex-router.js",
    });

    expect(result.realCodexPath).toBe(realCodexPath);
    await expect(readFile(result.wrapperPath, "utf8")).resolves.toContain("CODEX_ROUTER_REAL_CODEX");
    await expect(readFile(path.join(routerHome, "state", "wrapper.json"), "utf8")).resolves.toContain(realCodexPath);
  });

  test("runs the selected account through the managed runtime", async () => {
    await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const invocations: Array<{ command: string; args: string[]; codexHome: string | undefined }> = [];

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
      runner: async (command, args, options) => {
        invocations.push({ command, args, codexHome: options.env.CODEX_HOME });

        if (args[0] === "login") {
          await writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), `{\"tag\":\"${path.basename(options.env.CODEX_HOME!)}\"}\n`, "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    await service.switchTo("codex-1");

    const exitCode = await service.runSelectedCodex(["--version"]);

    expect(exitCode).toBe(0);
    expect(path.basename(invocations.at(-1)?.command ?? "")).toBe("codex");
    expect(invocations.at(-1)?.args).toEqual(["--version"]);
    expect(invocations.at(-1)?.codexHome).toBe(path.join(routerHome, "runtime", "current-home"));
  });

  test("mirrors default codex state before routed runs and persists runtime changes back", async () => {
    const fakeHome = await prepareFakeCodexHome();
    const routerHome = await makeTempDir();
    const defaultCodexHome = path.join(fakeHome, ".codex");

    await mkdir(path.join(defaultCodexHome, "skills", ".system"), { recursive: true });
    await mkdir(path.join(defaultCodexHome, "mcp-servers"), { recursive: true });
    await mkdir(path.join(defaultCodexHome, "plugins"), { recursive: true });
    await mkdir(path.join(defaultCodexHome, "packages"), { recursive: true });
    await writeFile(path.join(defaultCodexHome, "config.toml"), 'model = "gpt-5.6"\n', "utf8");
    await writeFile(path.join(defaultCodexHome, "history.jsonl"), "from-source\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "skills", ".system", "fresh.txt"), "skill\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "mcp-servers", "fresh.json"), "{\"ok\":true}\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "plugins", "fresh.txt"), "plugin\n", "utf8");
    await writeFile(path.join(defaultCodexHome, "packages", "fresh.txt"), "pkg\n", "utf8");

    await mkdir(path.join(routerHome, "shared", "skills", ".system"), { recursive: true });
    await mkdir(path.join(routerHome, "shared", "plugins"), { recursive: true });
    await mkdir(path.join(routerHome, "shared", "packages"), { recursive: true });
    await writeFile(path.join(routerHome, "shared", "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    await writeFile(path.join(routerHome, "shared", "history.jsonl"), "[]\n", "utf8");
    await writeFile(path.join(routerHome, "shared", "skills", ".system", "old.txt"), "old\n", "utf8");
    await writeFile(path.join(routerHome, "shared", "plugins", "old.txt"), "old\n", "utf8");
    await writeFile(path.join(routerHome, "shared", "packages", "old.txt"), "old\n", "utf8");

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
          return { exitCode: 0, stderr: "", stdout: "" };
        }

        if (options.env.CODEX_HOME) {
          await writeFile(path.join(options.env.CODEX_HOME, "config.toml"), 'model = "gpt-5.7"\n', "utf8");
          await writeFile(path.join(options.env.CODEX_HOME, "history.jsonl"), "from-runtime\n", "utf8");
          await mkdir(path.join(options.env.CODEX_HOME, "packages"), { recursive: true });
          await writeFile(path.join(options.env.CODEX_HOME, "packages", "runtime.txt"), "runtime\n", "utf8");
        }

        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await service.login("codex-1");
    await service.switchTo("codex-1");
    await service.runSelectedCodex(["--version"]);

    await expect(readFile(path.join(routerHome, "shared", "config.toml"), "utf8")).resolves.toContain(
      'model = "gpt-5.7"',
    );
    await expect(readFile(path.join(routerHome, "shared", "skills", ".system", "fresh.txt"), "utf8")).resolves.toContain(
      "skill",
    );
    await expect(readFile(path.join(routerHome, "shared", "mcp-servers", "fresh.json"), "utf8")).resolves.toContain(
      "\"ok\":true",
    );
    await expect(readFile(path.join(routerHome, "shared", "plugins", "fresh.txt"), "utf8")).resolves.toContain(
      "plugin",
    );
    await expect(readFile(path.join(routerHome, "shared", "packages", "runtime.txt"), "utf8")).resolves.toContain(
      "runtime",
    );
    await expect(readFile(path.join(routerHome, "shared", "history.jsonl"), "utf8")).resolves.toContain(
      "from-runtime",
    );
    await expect(readFile(path.join(defaultCodexHome, "config.toml"), "utf8")).resolves.toContain(
      'model = "gpt-5.7"',
    );
    await expect(readFile(path.join(defaultCodexHome, "history.jsonl"), "utf8")).resolves.toContain(
      "from-runtime",
    );
    await expect(readFile(path.join(defaultCodexHome, "packages", "runtime.txt"), "utf8")).resolves.toContain(
      "runtime",
    );
  });
});
