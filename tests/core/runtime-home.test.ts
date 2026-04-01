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

  test("assembles a runtime home with shared state, selected auth, and forced file auth config", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(path.join(layout.sharedDir, "sessions"), { recursive: true });
    await mkdir(path.join(layout.sharedDir, "mcp-servers"), { recursive: true });
    await mkdir(path.join(layout.sharedDir, "skills", ".system"), { recursive: true });
    await writeFile(path.join(layout.sharedDir, "history.jsonl"), "{\"hello\":\"world\"}\n", "utf8");
    await writeFile(path.join(layout.sharedDir, "models_cache.json"), "{\"model\":\"gpt-5.4\"}\n", "utf8");
    await writeFile(
      path.join(layout.sharedDir, "config.toml"),
      "model = \"gpt-5.4\"\n",
      "utf8",
    );

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
    expect(config).toContain("model = \"gpt-5.4\"");
    expect(config).toContain("cli_auth_credentials_store = \"file\"");

    const sessionsTarget = await realpath(path.join(runtime.runtimeHomeDir, "sessions"));
    expect(sessionsTarget).toBe(await realpath(path.join(layout.sharedDir, "sessions")));

    const mcpTarget = await realpath(path.join(runtime.runtimeHomeDir, "mcp-servers"));
    expect(mcpTarget).toBe(await realpath(path.join(layout.sharedDir, "mcp-servers")));

    const skillsTarget = await realpath(path.join(runtime.runtimeHomeDir, "skills"));
    expect(skillsTarget).toBe(await realpath(path.join(layout.sharedDir, "skills")));

    const modelsTarget = await realpath(path.join(runtime.runtimeHomeDir, "models_cache.json"));
    expect(modelsTarget).toBe(await realpath(path.join(layout.sharedDir, "models_cache.json")));
  });

  test("imports all non-auth Codex state into shared storage", async () => {
    const routerHome = await makeRouterHome();
    const sourceHome = path.join(routerHome, "source-codex-home");
    const layout = await ensureRouterLayout(routerHome);

    await mkdir(path.join(sourceHome, "sessions"), { recursive: true });
    await mkdir(path.join(sourceHome, "mcp-servers"), { recursive: true });
    await mkdir(path.join(sourceHome, "plugins"), { recursive: true });
    await mkdir(path.join(sourceHome, "skills", ".system"), { recursive: true });
    await writeFile(path.join(sourceHome, "history.jsonl"), "[]\n", "utf8");
    await writeFile(path.join(sourceHome, "config.toml"), "model = \"gpt-5.4\"\n", "utf8");
    await writeFile(path.join(sourceHome, "models_cache.json"), "{\"model\":\"gpt-5.4\"}\n", "utf8");
    await writeFile(path.join(sourceHome, "auth.json"), "{\"do\":\"not-copy\"}\n", "utf8");
    await writeFile(path.join(sourceHome, "plugins", "keep.txt"), "plugin\n", "utf8");
    await writeFile(path.join(sourceHome, "skills", ".system", "keep.txt"), "skill\n", "utf8");

    await importSharedState({
      sourceCodexHome: sourceHome,
      routerHome,
    });

    await expect(readFile(path.join(layout.sharedDir, "history.jsonl"), "utf8")).resolves.toContain(
      "[]",
    );
    await expect(readFile(path.join(layout.sharedDir, "config.toml"), "utf8")).resolves.toContain(
      "gpt-5.4",
    );
    await expect(stat(path.join(layout.sharedDir, "mcp-servers"))).resolves.toBeTruthy();
    await expect(readFile(path.join(layout.sharedDir, "models_cache.json"), "utf8")).resolves.toContain(
      "gpt-5.4",
    );
    await expect(readFile(path.join(layout.sharedDir, "skills", ".system", "keep.txt"), "utf8")).resolves.toContain(
      "skill",
    );
    await expect(readFile(path.join(layout.sharedDir, "auth.json"), "utf8")).rejects.toThrow();
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

    await expect(readFile(path.join(layout.sharedDir, "plugins", "keep.txt"), "utf8")).resolves.toContain(
      "plugin",
    );
    await expect(lstat(path.join(layout.sharedDir, "plugins"))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
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

  test("persists runtime-created non-auth state back into shared storage on rebuild", async () => {
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
    await mkdir(path.join(layout.runtimeCurrentHomeDir, "skills", ".system"), { recursive: true });
    await writeFile(path.join(layout.runtimeCurrentHomeDir, "skills", ".system", "persist.txt"), "skill\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-1",
      authSourcePath: authPath,
    });

    await expect(readFile(path.join(layout.sharedDir, "models_cache.json"), "utf8")).resolves.toContain(
      "cached",
    );
    await expect(readFile(path.join(layout.sharedDir, "skills", ".system", "persist.txt"), "utf8")).resolves.toContain(
      "skill",
    );

    const persistedModelsTarget = await realpath(path.join(layout.runtimeCurrentHomeDir, "models_cache.json"));
    expect(persistedModelsTarget).toBe(await realpath(path.join(layout.sharedDir, "models_cache.json")));
  });

  test("rewrites runtime config without duplicating managed auth settings", async () => {
    const routerHome = await makeRouterHome();
    const layout = await ensureRouterLayout(routerHome);

    await writeFile(
      path.join(layout.sharedDir, "config.toml"),
      [
        'model = "gpt-5.4"',
        "# Managed by codex-router for codex-1",
        'cli_auth_credentials_store = "file"',
        "",
      ].join("\n"),
      "utf8",
    );

    const authPath = path.join(layout.accountsDir, "codex-2", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{\"access_token\":\"secret\"}\n", "utf8");

    await assembleRuntimeHome({
      routerHome,
      tag: "codex-2",
      authSourcePath: authPath,
    });

    const config = await readFile(path.join(layout.runtimeCurrentHomeDir, "config.toml"), "utf8");
    expect(config.match(/cli_auth_credentials_store = "file"/g)?.length).toBe(1);
    expect(config).toContain("# Managed by codex-router for codex-2");
  });
});
