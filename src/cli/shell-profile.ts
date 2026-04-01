import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ShellProfileUpdateResult {
  changed: boolean;
  profilePath?: string;
  reloadCommand?: string;
  skippedReason?: string;
}

interface ShellProfileTarget {
  profilePath: string;
  reloadCommand: string;
  snippet: string;
}

const MANAGED_BLOCK_START = "# >>> codex-router >>>";
const MANAGED_BLOCK_END = "# <<< codex-router <<<";
const MANAGED_BLOCK_PATTERN = new RegExp(
  `${MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
  "g",
);

function detectShellProfileTarget(routerBinDir: string, shellPath = process.env.SHELL, homeDir = os.homedir()): ShellProfileTarget | undefined {
  const shellName = shellPath ? path.basename(shellPath) : undefined;

  if (shellName === "zsh") {
    return {
      profilePath: path.join(homeDir, ".zshrc"),
      reloadCommand: "source ~/.zshrc",
      snippet: `export PATH="${routerBinDir}:$PATH"`,
    };
  }

  if (shellName === "bash") {
    return {
      profilePath: path.join(homeDir, ".bashrc"),
      reloadCommand: "source ~/.bashrc",
      snippet: `export PATH="${routerBinDir}:$PATH"`,
    };
  }

  return undefined;
}

export async function updateShellProfile(routerBinDir: string): Promise<ShellProfileUpdateResult> {
  const target = detectShellProfileTarget(routerBinDir);
  if (!target) {
    return {
      changed: false,
      skippedReason: "Unsupported shell for automatic PATH setup.",
    };
  }

  let existing = "";
  try {
    existing = await readFile(target.profilePath, "utf8");
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const managedBlock = `${MANAGED_BLOCK_START}\n${target.snippet}\n${MANAGED_BLOCK_END}`;
  if (existing.includes(MANAGED_BLOCK_START) && existing.includes(target.snippet)) {
    return {
      changed: false,
      profilePath: target.profilePath,
      reloadCommand: target.reloadCommand,
    };
  }

  const existingWithoutManagedBlock = existing.replace(MANAGED_BLOCK_PATTERN, "").trimEnd();
  const next = `${existingWithoutManagedBlock}${existingWithoutManagedBlock ? "\n\n" : ""}${managedBlock}\n`;
  await mkdir(path.dirname(target.profilePath), { recursive: true });
  await writeFile(target.profilePath, next, "utf8");

  return {
    changed: true,
    profilePath: target.profilePath,
    reloadCommand: target.reloadCommand,
  };
}
