import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { getRouterLayout } from "./paths.js";

export interface WrapperConfig {
  realCodexPath: string;
}

export interface WrapperInstallResult {
  wrapperPath: string;
  realCodexPath: string;
  pathHint: string;
}

export type WrapperLauncher =
  | {
      kind: "command";
      command: string;
    }
  | {
      kind: "node";
      nodePath: string;
      scriptPath: string;
    }
  | {
      kind: "tsx";
      tsxPath: string;
      scriptPath: string;
    };

function getWrapperConfigPath(routerHome: string): string {
  return path.join(getRouterLayout(routerHome).stateDir, "wrapper.json");
}

function getWrapperPath(routerHome: string): string {
  return path.join(routerHome, "bin", "codex");
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function renderLauncherCommand(launcher: WrapperLauncher): string {
  switch (launcher.kind) {
    case "command":
      return `${quoteShell(launcher.command)} proxy "$@"`;
    case "node":
      return `${quoteShell(launcher.nodePath)} ${quoteShell(launcher.scriptPath)} proxy "$@"`;
    case "tsx":
      return `${quoteShell(launcher.tsxPath)} ${quoteShell(launcher.scriptPath)} proxy "$@"`;
  }
}

function renderWrapperScript(realCodexPath: string, launcher: WrapperLauncher): string {
  return [
    "#!/bin/sh",
    `export CODEX_ROUTER_REAL_CODEX=${quoteShell(realCodexPath)}`,
    `exec ${renderLauncherCommand(launcher)}`,
    "",
  ].join("\n");
}

export async function readWrapperConfig(routerHome: string): Promise<WrapperConfig | undefined> {
  try {
    const raw = await readFile(getWrapperConfigPath(routerHome), "utf8");
    return JSON.parse(raw) as WrapperConfig;
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function resolveConfiguredCodexPath(routerHome: string): Promise<string | undefined> {
  const config = await readWrapperConfig(routerHome);
  return config?.realCodexPath;
}

async function writeWrapperConfig(routerHome: string, config: WrapperConfig): Promise<void> {
  const configPath = getWrapperConfigPath(routerHome);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function isExecutable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findRealCodexPath(routerHome: string, pathValue = process.env.PATH ?? ""): Promise<string> {
  const wrapperPath = getWrapperPath(routerHome);
  const configured = await resolveConfiguredCodexPath(routerHome);
  if (configured && (await isExecutable(configured))) {
    return configured;
  }

  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }

    const candidate = path.join(segment, "codex");
    if (candidate === wrapperPath) {
      continue;
    }

    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to locate the real codex executable on PATH.");
}

export async function installCodexWrapper(
  routerHome: string,
  realCodexPath: string,
  launcher: WrapperLauncher,
): Promise<WrapperInstallResult> {
  const wrapperPath = getWrapperPath(routerHome);
  await mkdir(path.dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, renderWrapperScript(realCodexPath, launcher), "utf8");
  await chmod(wrapperPath, 0o755);
  await writeWrapperConfig(routerHome, { realCodexPath });

  return {
    wrapperPath,
    realCodexPath,
    pathHint: `export PATH=${quoteShell(path.dirname(wrapperPath))}:$PATH`,
  };
}
