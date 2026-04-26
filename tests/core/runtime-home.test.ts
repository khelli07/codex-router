import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  assembleRuntimeHome,
  ensureRouterLayout,
  importSharedState,
  isSharedStateEmpty,
  persistRuntimeStateToShared,
} from "../../src/core/runtime-home.js";

const tempDirs: string[] = [];

async function makeRouterHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-router-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("runtime home assembly", () => {
  test("creates the managed directory layout", async () => {
    const routerHome = await makeRouterHome();

    const layout = await ensureRouterLayout(routerHome);

    await expect(stat(layout.sharedDir)).resolves.toBeTruthy();
    await expect(stat(layout.accountsDir)).resolves.toBeTruthy();
    await expect(stat(layout.runtimeCurrentHomeDir)).resolves.toBeTruthy();
    await expect(stat(layout.stateDir)).resolves.toBeTruthy();
  });

  test("assembles a runtime home with shared state, selected auth, and shared config", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(path.join(layout.sharedDir, "sessions"), { recursive: true });
    await mkdir(path.join(layout.sharedDir, "mcp-servers"), { recursive: true });
    await mkdir(path.join(layout.sharedDir, "skills", ".system"), { recursive: true });
    await writeFile(path.join(layout.sharedDir, "history.jsonl"), "{\"hello\":\"world\"}\n", "utf8");
    await writeFile(path.join(layout.sharedDir, "models_cache.json"), "{\"model\":\"gpt-5.4\"}\n", "utf8");
    await writeFile(path.join(layout.sharedDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const authPath = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    const runtime = await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    const runtimeAuth = await readFile(path.join(runtime.runtimeHomeDir, "auth.json"), "utf8");
    expect(runtimeAuth).toContain("access_token");

    const config = await readFile(path.join(runtime.runtimeHomeDir, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.4"');
    expect(config.match(/cli_auth_credentials_store = "file"/g)?.length).toBe(1);

    const configTarget = await realpath(path.join(runtime.runtimeHomeDir, "config.toml"));
    expect(configTarget).toBe(await realpath(path.join(layout.sharedDir, "config.toml")));

    const sessionsTarget = await realpath(path.join(runtime.runtimeHomeDir, "sessions"));
    expect(sessionsTarget).toBe(await realpath(path.join(layout.sharedDir, "sessions")));

    const mcpTarget = await realpath(path.join(runtime.runtimeHomeDir, "mcp-servers"));
    expect(mcpTarget).toBe(await realpath(path.join(layout.sharedDir, "mcp-servers")));

    const skillsTarget = await realpath(path.join(runtime.runtimeHomeDir, "skills"));
    expect(skillsTarget).toBe(await realpath(path.join(layout.sharedDir, "skills")));

    const modelsTarget = await realpath(path.join(runtime.runtimeHomeDir, "models_cache.json"));
    expect(modelsTarget).toBe(await realpath(path.join(layout.sharedDir, "models_cache.json")));
  });

  test("imports all non-auth Codex state into shared storage and normalizes config", async () => {
    const routerHome = await makeRouterHome();
    const sourceHome = path.join(routerHome, "source-codex-home");
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(path.join(sourceHome, "sessions"), { recursive: true });
    await mkdir(path.join(sourceHome, "mcp-servers"), { recursive: true });
    await mkdir(path.join(sourceHome, "plugins"), { recursive: true });
    await mkdir(path.join(sourceHome, "skills", ".system"), { recursive: true });
    await writeFile(path.join(sourceHome, "history.jsonl"), "[]\n", "utf8");
    await writeFile(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    await writeFile(path.join(sourceHome, "models_cache.json"), "{\"model\":\"gpt-5.4\"}\n", "utf8");
    await writeFile(path.join(sourceHome, "auth.json"), "{\"do\":\"not-copy\"}\n", "utf8");
    await writeFile(path.join(sourceHome, "plugins", "keep.txt"), "plugin\n", "utf8");
    await writeFile(path.join(sourceHome, "skills", ".system", "keep.txt"), "skill\n", "utf8");

    await importSharedState({
      sourceCodexHome: sourceHome,
      routerHome,
    });

    await expect(readFile(path.join(layout.sharedDir, "history.jsonl"), "utf8")).resolves.toContain("[]");
    await expect(readFile(path.join(layout.sharedDir, "config.toml"), "utf8")).resolves.toContain("gpt-5.4");
    await expect(readFile(path.join(layout.sharedDir, "config.toml"), "utf8")).resolves.toContain(
      'cli_auth_credentials_store = "file"',
    );
    await expect(stat(path.join(layout.sharedDir, "mcp-servers"))).resolves.toBeTruthy();
    await expect(readFile(path.join(layout.sharedDir, "models_cache.json"), "utf8")).resolves.toContain("gpt-5.4");
    await expect(readFile(path.join(layout.sharedDir, "skills", ".system", "keep.txt"), "utf8")).resolves.toContain(
      "skill",
    );
    await expect(readFile(path.join(layout.sharedDir, "auth.json"), "utf8")).rejects.toThrow();
  });

  test("keeps injected auth config at the TOML top level", async () => {
    const routerHome = await makeRouterHome();
    const sourceHome = path.join(routerHome, "source-codex-home");
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(sourceHome, { recursive: true });
    await writeFile(
      path.join(sourceHome, "config.toml"),
      'model = "gpt-5.5"\n\n[tui.model_availability_nux]\n"gpt-5.5" = 1\n',
      "utf8",
    );

    await importSharedState({
      sourceCodexHome: sourceHome,
      routerHome,
    });

    const configLines = (await readFile(path.join(layout.sharedDir, "config.toml"), "utf8")).split("\n");
    const authConfigIndex = configLines.indexOf('cli_auth_credentials_store = "file"');
    const tuiTableIndex = configLines.indexOf("[tui.model_availability_nux]");

    expect(authConfigIndex).toBeGreaterThanOrEqual(0);
    expect(tuiTableIndex).toBeGreaterThanOrEqual(0);
    expect(authConfigIndex).toBeLessThan(tuiTableIndex);
  });

  test("dereferences imported symlinks instead of copying them as managed symlinks", async () => {
    const routerHome = await makeRouterHome();
    const sourceHome = path.join(routerHome, "source-codex-home");
    const realPluginDir = path.join(routerHome, "real-plugins");
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(realPluginDir, { recursive: true });
    await mkdir(sourceHome, { recursive: true });
    await writeFile(path.join(realPluginDir, "keep.txt"), "plugin\n", "utf8");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(realPluginDir, path.join(sourceHome, "plugins")),
    );

    await importSharedState({
      sourceCodexHome: sourceHome,
      routerHome,
    });

    await expect(readFile(path.join(layout.sharedDir, "plugins", "keep.txt"), "utf8")).resolves.toContain("plugin");
    expect((await lstat(path.join(layout.sharedDir, "plugins"))).isSymbolicLink()).toBe(false);
  });

  test("rejects importing from the router-managed runtime home", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await expect(
      importSharedState({
        sourceCodexHome: layout.runtimeCurrentHomeDir,
        routerHome,
      }),
    ).rejects.toThrow(/router-managed runtime home/i);
  });

  test("removes self-referential shared symlinks during layout repair", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);
    const loopPath = path.join(layout.sharedDir, "history.jsonl");

    await import("node:fs/promises").then(({ symlink }) => symlink(loopPath, loopPath));

    await ensureRouterLayout(routerHome);

    await expect(lstat(loopPath)).rejects.toThrow();
  });

  test("persists runtime-created top-level entries back into shared storage on rebuild", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    const authPath = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await writeFile(path.join(layout.runtimeCurrentHomeDir, "models_cache.json"), "{\"cached\":true}\n", "utf8");
    await mkdir(path.join(layout.runtimeCurrentHomeDir, "packages"), { recursive: true });
    await writeFile(path.join(layout.runtimeCurrentHomeDir, "packages", "persist.txt"), "pkg\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await expect(readFile(path.join(layout.sharedDir, "models_cache.json"), "utf8")).resolves.toContain("cached");
    await expect(readFile(path.join(layout.sharedDir, "packages", "persist.txt"), "utf8")).resolves.toContain("pkg");

    const packagesTarget = await realpath(path.join(layout.runtimeCurrentHomeDir, "packages"));
    expect(packagesTarget).toBe(await realpath(path.join(layout.sharedDir, "packages")));
  });

  test("reuses the existing runtime home when the selected tag has not changed", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await writeFile(path.join(layout.sharedDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const authPath = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret-1\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    const firstAuthStat = await stat(path.join(layout.runtimeCurrentHomeDir, "auth.json"));

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    const secondAuthStat = await stat(path.join(layout.runtimeCurrentHomeDir, "auth.json"));
    expect(secondAuthStat.ino).toBe(firstAuthStat.ino);
    await expect(readFile(path.join(layout.runtimeCurrentHomeDir, "auth.json"), "utf8")).resolves.toContain("secret-1");
  });

  test("rebuilds the runtime home when the selected tag changes", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await writeFile(path.join(layout.sharedDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const authPathOne = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPathOne), { recursive: true });
    await writeFile(authPathOne, "{\"access_token\":\"secret-1\"}\n", "utf8");

    const authPathTwo = path.join(layout.accountsDir, "codex-2", "auth.json");
    await mkdir(path.dirname(authPathTwo), { recursive: true });
    await writeFile(authPathTwo, "{\"access_token\":\"secret-2\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPathOne,
    });

    const firstAuthStat = await stat(path.join(layout.runtimeCurrentHomeDir, "auth.json"));

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-2",
      authSourcePath: authPathTwo,
    });

    const secondAuthStat = await stat(path.join(layout.runtimeCurrentHomeDir, "auth.json"));
    expect(secondAuthStat.ino).not.toBe(firstAuthStat.ino);
    await expect(readFile(path.join(layout.runtimeCurrentHomeDir, "auth.json"), "utf8")).resolves.toContain("secret-2");
  });

  test("does not delete shared entries when runtime symlinks are removed", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(path.join(layout.sharedDir, "packages"), { recursive: true });
    await writeFile(path.join(layout.sharedDir, "packages", "keep.txt"), "pkg\n", "utf8");
    await writeFile(path.join(layout.sharedDir, "history.jsonl"), "history\n", "utf8");

    const authPath = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await rm(path.join(layout.runtimeCurrentHomeDir, "packages"), { force: true, recursive: true });
    await rm(path.join(layout.runtimeCurrentHomeDir, "history.jsonl"), { force: true });

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await expect(readFile(path.join(layout.sharedDir, "packages", "keep.txt"), "utf8")).resolves.toContain("pkg");
    await expect(readFile(path.join(layout.sharedDir, "history.jsonl"), "utf8")).resolves.toContain("history");
  });

  test("skips transient sqlite sidecars that disappear during runtime persistence", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await writeFile(path.join(layout.sharedDir, "logs_1.sqlite"), "db\n", "utf8");
    await writeFile(path.join(layout.sharedDir, "logs_1.sqlite-shm"), "shm\n", "utf8");

    const authPath = path.join(layout.accountsDir, "codex-1", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await rm(path.join(layout.sharedDir, "logs_1.sqlite-shm"), { force: true });

    await expect(persistRuntimeStateToShared(routerHome)).resolves.toBeUndefined();
    await expect(readFile(path.join(layout.sharedDir, "logs_1.sqlite"), "utf8")).resolves.toContain("db");
  });

  test("persists non-symlink runtime config updates back into shared storage", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await writeFile(path.join(layout.sharedDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const authPath = path.join(layout.accountsDir, "codex-2", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-2",
      authSourcePath: authPath,
    });

    await rm(path.join(layout.runtimeCurrentHomeDir, "config.toml"), { force: true });
    await writeFile(path.join(layout.runtimeCurrentHomeDir, "config.toml"), 'model = "gpt-5.6"\n', "utf8");

    await persistRuntimeStateToShared(routerHome);

    const config = await readFile(path.join(layout.sharedDir, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6"');
    expect(config.match(/cli_auth_credentials_store = "file"/g)?.length).toBe(1);

    const runtimeConfigTarget = await realpath(path.join(layout.runtimeCurrentHomeDir, "config.toml"));
    expect(runtimeConfigTarget).toBe(await realpath(path.join(layout.sharedDir, "config.toml")));
  });

  test("relinks non-symlink runtime entries back to shared storage after persistence", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    const authPath = path.join(layout.accountsDir, "codex-3", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-3",
      authSourcePath: authPath,
    });

    await writeFile(path.join(layout.runtimeCurrentHomeDir, "history.jsonl"), "from-runtime\n", "utf8");
    await persistRuntimeStateToShared(routerHome);

    await expect(readFile(path.join(layout.sharedDir, "history.jsonl"), "utf8")).resolves.toContain("from-runtime");

    const runtimeHistoryTarget = await realpath(path.join(layout.runtimeCurrentHomeDir, "history.jsonl"));
    expect(runtimeHistoryTarget).toBe(await realpath(path.join(layout.sharedDir, "history.jsonl")));
  });

  test("reports whether router shared state is empty", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await expect(isSharedStateEmpty(routerHome)).resolves.toBe(true);

    await writeFile(path.join(layout.sharedDir, "history.jsonl"), "history\n", "utf8");

    await expect(isSharedStateEmpty(routerHome)).resolves.toBe(false);
  });
});
