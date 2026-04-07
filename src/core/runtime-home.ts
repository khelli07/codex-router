import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { getRouterLayout, type RouterLayout } from "./paths.js";

const EXCLUDED_SHARED_ENTRY_NAMES = new Set(["auth.json"]);
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

function isMissingPathError(error: unknown): boolean {
  const asNodeError = error as NodeJS.ErrnoException;
  return asNodeError.code === "ENOENT";
}

async function resolveExistingPath(targetPath: string): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function materializeSharedSymlinks(layout: RouterLayout): Promise<void> {
  if (!(await pathExists(layout.sharedDir))) {
    return;
  }

  for (const name of await readdir(layout.sharedDir)) {
    const target = path.join(layout.sharedDir, name);
    const targetStat = await lstat(target);
    if (!targetStat.isSymbolicLink()) {
      continue;
    }

    let resolvedTarget: string | undefined;
    try {
      resolvedTarget = await realpath(target);
    } catch (error) {
      const asNodeError = error as NodeJS.ErrnoException;
      if (asNodeError.code === "ELOOP") {
        await rm(target, { force: true, recursive: true });
        continue;
      }

      throw error;
    }

    if (!resolvedTarget || resolvedTarget === target) {
      await rm(target, { force: true, recursive: true });
      continue;
    }

    const resolvedStat = await stat(target);
    await rm(target, { force: true, recursive: true });
    await cp(resolvedTarget, target, {
      recursive: resolvedStat.isDirectory(),
      dereference: true,
    });
  }
}

async function ensurePrivateDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
  await chmod(targetPath, 0o700);
}

async function copyIntoManagedState(source: string, target: string): Promise<void> {
  try {
    const sourceStat = await lstat(source);

    let actualSource = source;
    let actualStat = sourceStat;
    if (sourceStat.isSymbolicLink()) {
      actualSource = await realpath(source);
      actualStat = await stat(source);
    }

    const resolvedTarget = await resolveExistingPath(target);
    if (resolvedTarget && resolvedTarget === actualSource) {
      return;
    }

    await rm(target, { force: true, recursive: true });
    await cp(actualSource, target, {
      recursive: actualStat.isDirectory(),
      dereference: true,
    });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

function normalizeSharedConfigContents(contents: string): string {
  const sanitized = contents
    .split("\n")
    .filter((line) => !line.startsWith("# Managed by codex-router for "))
    .filter((line) => !line.trimStart().startsWith('cli_auth_credentials_store = '))
    .join("\n")
    .trimEnd();

  return [sanitized, 'cli_auth_credentials_store = "file"'].filter(Boolean).join("\n");
}

async function writeNormalizedSharedConfig(sourcePath: string, targetPath: string): Promise<void> {
  try {
    const normalized = normalizeSharedConfigContents(await readFile(sourcePath, "utf8"));
    await writeFile(targetPath, `${normalized}\n`, "utf8");
    await chmod(targetPath, 0o600);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

async function ensureSharedConfig(sharedDir: string): Promise<void> {
  const configPath = path.join(sharedDir, "config.toml");
  const currentContents = (await pathExists(configPath)) ? await readFile(configPath, "utf8") : "";
  await writeFile(configPath, `${normalizeSharedConfigContents(currentContents)}\n`, "utf8");
  await chmod(configPath, 0o600);
}

async function copyShareableEntries(sourceHome: string, targetHome: string): Promise<void> {
  await ensurePrivateDirectory(targetHome);

  for (const sourceName of await listShareableEntryNames(sourceHome)) {
    const sourcePath = path.join(sourceHome, sourceName);
    const targetPath = path.join(targetHome, sourceName);

    if (sourceName === "config.toml") {
      await writeNormalizedSharedConfig(sourcePath, targetPath);
      continue;
    }

    await copyIntoManagedState(sourcePath, targetPath);
  }

  await ensureSharedConfig(targetHome);
}

async function assertImportSourceAllowed(sourceCodexHome: string, layout: RouterLayout): Promise<void> {
  const resolvedSource = await resolveExistingPath(sourceCodexHome);
  if (!resolvedSource) {
    return;
  }

  const resolvedRuntimeHome =
    (await resolveExistingPath(layout.runtimeCurrentHomeDir)) ?? layout.runtimeCurrentHomeDir;
  if (resolvedSource === resolvedRuntimeHome) {
    throw new Error("Cannot import from the router-managed runtime home. Restore or use a real Codex home instead.");
  }
}

async function ensureSharedContainers(layout: RouterLayout): Promise<void> {
  await Promise.all([
    ensurePrivateDirectory(layout.sharedDir),
    ensurePrivateDirectory(layout.accountsDir),
    ensurePrivateDirectory(layout.runtimeCurrentHomeDir),
    ensurePrivateDirectory(layout.stateDir),
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

async function entryMirrorsSharedSource(runtimePath: string, sharedPath: string): Promise<boolean> {
  try {
    const runtimeStat = await lstat(runtimePath);
    if (!runtimeStat.isSymbolicLink()) {
      return false;
    }

    const [resolvedRuntime, resolvedShared] = await Promise.all([
      resolveExistingPath(runtimePath),
      resolveExistingPath(sharedPath),
    ]);
    return Boolean(resolvedRuntime && resolvedShared && resolvedRuntime === resolvedShared);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

export async function isSharedStateEmpty(routerHome: string): Promise<boolean> {
  const layout = await ensureRouterLayout(routerHome);
  return (await listShareableEntryNames(layout.sharedDir)).length === 0;
}

export async function persistRuntimeStateToShared(routerHome: string): Promise<void> {
  const layout = await ensureRouterLayout(routerHome);
  if (!(await pathExists(layout.runtimeCurrentHomeDir))) {
    return;
  }

  if ((await readdir(layout.runtimeCurrentHomeDir)).length === 0) {
    await ensureSharedConfig(layout.sharedDir);
    return;
  }

  for (const name of await listShareableEntryNames(layout.runtimeCurrentHomeDir)) {
    const runtimePath = path.join(layout.runtimeCurrentHomeDir, name);
    const sharedPath = path.join(layout.sharedDir, name);

    if (await entryMirrorsSharedSource(runtimePath, sharedPath)) {
      continue;
    }

    if (name === "config.toml") {
      await writeNormalizedSharedConfig(runtimePath, sharedPath);
      await relinkRuntimeEntryToShared(layout.sharedDir, layout.runtimeCurrentHomeDir, name);
      continue;
    }

    await copyIntoManagedState(runtimePath, sharedPath);
    await relinkRuntimeEntryToShared(layout.sharedDir, layout.runtimeCurrentHomeDir, name);
  }

  await ensureSharedConfig(layout.sharedDir);
}

async function linkSharedEntry(sharedDir: string, runtimeHomeDir: string, name: string): Promise<void> {
  const source = path.join(sharedDir, name);

  if (!(await pathExists(source))) {
    return;
  }

  const target = path.join(runtimeHomeDir, name);
  await symlink(source, target);
}

async function relinkRuntimeEntryToShared(
  sharedDir: string,
  runtimeHomeDir: string,
  name: string,
): Promise<void> {
  const sharedPath = path.join(sharedDir, name);
  if (!(await pathExists(sharedPath))) {
    return;
  }

  const runtimePath = path.join(runtimeHomeDir, name);
  await rm(runtimePath, { force: true, recursive: true });
  await symlink(sharedPath, runtimePath);
}

export async function ensureRouterLayout(routerHome: string): Promise<RouterLayout> {
  const layout = getRouterLayout(routerHome);
  await ensureSharedContainers(layout);
  await materializeSharedSymlinks(layout);
  return layout;
}

export async function seedSharedStateFromCodexHome(
  input: ImportSharedStateInput,
): Promise<RouterLayout> {
  const layout = await ensureRouterLayout(input.routerHome);
  await assertImportSourceAllowed(input.sourceCodexHome, layout);
  if (!(await pathExists(input.sourceCodexHome))) {
    return layout;
  }

  await copyShareableEntries(input.sourceCodexHome, layout.sharedDir);
  return layout;
}

export async function assembleRuntimeHome(
  input: AssembleRuntimeHomeInput,
): Promise<RuntimeHomeResult> {
  const layout = await ensureRouterLayout(input.routerHome);
  await persistRuntimeStateToShared(input.routerHome);
  await ensureSharedConfig(layout.sharedDir);

  const stagingDir = `${layout.runtimeCurrentHomeDir}.${process.pid}.${Date.now()}`;
  await ensurePrivateDirectory(stagingDir);

  try {
    for (const entry of await listShareableEntryNames(layout.sharedDir)) {
      await linkSharedEntry(layout.sharedDir, stagingDir, entry);
    }

    const authPath = path.join(stagingDir, "auth.json");
    await cp(input.authSourcePath, authPath);
    await chmod(authPath, 0o600);

    await rm(layout.runtimeCurrentHomeDir, { force: true, recursive: true });
    await rename(stagingDir, layout.runtimeCurrentHomeDir);

    return {
      runtimeHomeDir: layout.runtimeCurrentHomeDir,
      configPath: path.join(layout.runtimeCurrentHomeDir, "config.toml"),
      authPath: path.join(layout.runtimeCurrentHomeDir, "auth.json"),
    };
  } catch (error) {
    await rm(stagingDir, { force: true, recursive: true });
    throw error;
  }
}

export async function importSharedState(input: ImportSharedStateInput): Promise<RouterLayout> {
  const layout = await ensureRouterLayout(input.routerHome);
  await assertImportSourceAllowed(input.sourceCodexHome, layout);
  await copyShareableEntries(input.sourceCodexHome, layout.sharedDir);

  return layout;
}
