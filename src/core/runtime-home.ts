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

interface RestoreCodexHomeInput {
  sourceCodexHome: string;
  targetCodexHome: string;
}

interface PersistRuntimeStateInput {
  routerHome: string;
  targetCodexHome: string;
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
}

async function writeSanitizedConfig(sourcePath: string, targetPath: string): Promise<void> {
  const sanitized = sanitizeConfigContents(await readFile(sourcePath, "utf8"));
  await writeFile(targetPath, sanitized ? `${sanitized}\n` : "", "utf8");
  await chmod(targetPath, 0o600);
}

async function syncShareableEntries(sourceHome: string, targetHome: string): Promise<void> {
  await ensurePrivateDirectory(targetHome);

  const [sourceNames, targetNames] = await Promise.all([
    listShareableEntryNames(sourceHome),
    listShareableEntryNames(targetHome),
  ]);
  const sourceNameSet = new Set(sourceNames);

  for (const targetName of targetNames) {
    if (sourceNameSet.has(targetName)) {
      continue;
    }

    await rm(path.join(targetHome, targetName), { force: true, recursive: true });
  }

  for (const sourceName of sourceNames) {
    const sourcePath = path.join(sourceHome, sourceName);
    const targetPath = path.join(targetHome, sourceName);

    if (sourceName === "config.toml") {
      await writeSanitizedConfig(sourcePath, targetPath);
      continue;
    }

    await copyIntoManagedState(sourcePath, targetPath);
  }
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

function sanitizeConfigContents(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => !line.startsWith("# Managed by codex-router for "))
    .filter((line) => !line.trimStart().startsWith('cli_auth_credentials_store = '))
    .join("\n")
    .trimEnd();
}

async function syncRuntimeStateToShared(layout: RouterLayout): Promise<void> {
  if (!(await pathExists(layout.runtimeCurrentHomeDir))) {
    return;
  }

  if ((await readdir(layout.runtimeCurrentHomeDir)).length === 0) {
    return;
  }

  await syncShareableEntries(layout.runtimeCurrentHomeDir, layout.sharedDir);
}

async function writeRuntimeConfig(sharedDir: string, runtimeHomeDir: string, tag: string): Promise<string> {
  const sharedConfigPath = path.join(sharedDir, "config.toml");
  const runtimeConfigPath = path.join(runtimeHomeDir, "config.toml");

  const sharedConfig = (await pathExists(sharedConfigPath))
    ? await readFile(sharedConfigPath, "utf8")
    : "";
  const sanitizedSharedConfig = sanitizeConfigContents(sharedConfig);

  const managedConfig = [
    sanitizedSharedConfig.trimEnd(),
    "",
    `# Managed by codex-router for ${tag}`,
    'cli_auth_credentials_store = "file"',
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(runtimeConfigPath, `${managedConfig}\n`, "utf8");
  await chmod(runtimeConfigPath, 0o600);
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

  await syncShareableEntries(input.sourceCodexHome, layout.sharedDir);
  return layout;
}

export async function assembleRuntimeHome(
  input: AssembleRuntimeHomeInput,
): Promise<RuntimeHomeResult> {
  const layout = await ensureRouterLayout(input.routerHome);
  await syncRuntimeStateToShared(layout);

  const stagingDir = `${layout.runtimeCurrentHomeDir}.${process.pid}.${Date.now()}`;
  await ensurePrivateDirectory(stagingDir);

  try {
    for (const entry of await listShareableEntryNames(layout.sharedDir)) {
      if (entry === "config.toml") {
        continue;
      }

      await linkSharedEntry(layout.sharedDir, stagingDir, entry);
    }

    const authPath = path.join(stagingDir, "auth.json");
    await cp(input.authSourcePath, authPath);
    await chmod(authPath, 0o600);

    const configPath = await writeRuntimeConfig(layout.sharedDir, stagingDir, input.tag);

    await rm(layout.runtimeCurrentHomeDir, { force: true, recursive: true });
    await rename(stagingDir, layout.runtimeCurrentHomeDir);

    return {
      runtimeHomeDir: layout.runtimeCurrentHomeDir,
      configPath: path.join(layout.runtimeCurrentHomeDir, path.basename(configPath)),
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
  await syncShareableEntries(input.sourceCodexHome, layout.sharedDir);

  return layout;
}

export async function restoreCodexHomeFromSource(input: RestoreCodexHomeInput): Promise<void> {
  await syncShareableEntries(input.sourceCodexHome, input.targetCodexHome);
}

export async function persistRuntimeStateToCodexHome(input: PersistRuntimeStateInput): Promise<void> {
  const layout = await ensureRouterLayout(input.routerHome);
  await syncRuntimeStateToShared(layout);
  await syncShareableEntries(layout.sharedDir, input.targetCodexHome);
}
