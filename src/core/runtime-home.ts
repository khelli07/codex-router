import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { getRouterLayout, type RouterLayout } from "./paths.js";

const EXCLUDED_SHARED_ENTRY_NAMES = new Set(["auth.json"]);
const MANAGED_RUNTIME_ENTRY_NAMES = new Set(["auth.json", "config.toml"]);

export interface RuntimeHomeResult {
  runtimeHomeDir: string;
  configPath: string;
  authPath: string;
}

interface AssembleRuntimeHomeInput {
  routerHome: string;
  tag: string;
  authSourcePath: string;
}

interface ImportSharedStateInput {
  sourceCodexHome: string;
  routerHome: string;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensureSharedContainers(layout: RouterLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.sharedDir, { recursive: true }),
    mkdir(layout.accountsDir, { recursive: true }),
    mkdir(layout.runtimeCurrentHomeDir, { recursive: true }),
    mkdir(layout.stateDir, { recursive: true }),
  ]);
}

async function listShareableEntryNames(homeDir: string): Promise<string[]> {
  if (!(await pathExists(homeDir))) {
    return [];
  }

  const entries = await readdir(homeDir, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => !EXCLUDED_SHARED_ENTRY_NAMES.has(name))
    .sort();
}

async function syncRuntimeStateToShared(layout: RouterLayout): Promise<void> {
  if (!(await pathExists(layout.runtimeCurrentHomeDir))) {
    return;
  }

  for (const name of await readdir(layout.runtimeCurrentHomeDir)) {
    if (MANAGED_RUNTIME_ENTRY_NAMES.has(name)) {
      continue;
    }

    const source = path.join(layout.runtimeCurrentHomeDir, name);
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) {
      continue;
    }

    const target = path.join(layout.sharedDir, name);
    await rm(target, { force: true, recursive: true });
    await cp(source, target, { recursive: sourceStat.isDirectory() });
  }
}

async function writeRuntimeConfig(sharedDir: string, runtimeHomeDir: string, tag: string): Promise<string> {
  const sharedConfigPath = path.join(sharedDir, "config.toml");
  const runtimeConfigPath = path.join(runtimeHomeDir, "config.toml");

  const sharedConfig = (await pathExists(sharedConfigPath))
    ? await readFile(sharedConfigPath, "utf8")
    : "";

  const managedConfig = [
    sharedConfig.trimEnd(),
    "",
    `# Managed by codex-router for ${tag}`,
    'cli_auth_credentials_store = "file"',
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(runtimeConfigPath, `${managedConfig}\n`, "utf8");
  return runtimeConfigPath;
}

async function linkSharedEntry(sharedDir: string, runtimeHomeDir: string, name: string): Promise<void> {
  const source = path.join(sharedDir, name);

  if (!(await pathExists(source))) {
    return;
  }

  const target = path.join(runtimeHomeDir, name);
  await symlink(source, target);
}

export async function ensureRouterLayout(routerHome: string): Promise<RouterLayout> {
  const layout = getRouterLayout(routerHome);
  await ensureSharedContainers(layout);
  return layout;
}

export async function seedSharedStateFromCodexHome(
  input: ImportSharedStateInput,
): Promise<RouterLayout> {
  const layout = await ensureRouterLayout(input.routerHome);
  const existingEntries = await listShareableEntryNames(layout.sharedDir);
  if (existingEntries.length > 0) {
    return layout;
  }

  return await importSharedState(input);
}

export async function assembleRuntimeHome(
  input: AssembleRuntimeHomeInput,
): Promise<RuntimeHomeResult> {
  const layout = await ensureRouterLayout(input.routerHome);
  await syncRuntimeStateToShared(layout);

  await rm(layout.runtimeCurrentHomeDir, { force: true, recursive: true });
  await mkdir(layout.runtimeCurrentHomeDir, { recursive: true });

  for (const entry of await listShareableEntryNames(layout.sharedDir)) {
    if (entry === "config.toml") {
      continue;
    }

    await linkSharedEntry(layout.sharedDir, layout.runtimeCurrentHomeDir, entry);
  }

  const authPath = path.join(layout.runtimeCurrentHomeDir, "auth.json");
  await cp(input.authSourcePath, authPath);

  const configPath = await writeRuntimeConfig(layout.sharedDir, layout.runtimeCurrentHomeDir, input.tag);

  return {
    runtimeHomeDir: layout.runtimeCurrentHomeDir,
    configPath,
    authPath,
  };
}

export async function importSharedState(input: ImportSharedStateInput): Promise<RouterLayout> {
  const layout = await ensureRouterLayout(input.routerHome);
  for (const name of await listShareableEntryNames(input.sourceCodexHome)) {
    const source = path.join(input.sourceCodexHome, name);
    const target = path.join(layout.sharedDir, name);
    const sourceStat = await stat(source);

    await rm(target, { force: true, recursive: true });
    await cp(source, target, { recursive: sourceStat.isDirectory() });
  }

  return layout;
}
