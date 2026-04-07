#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { updateShellProfile } from "./shell-profile.js";
import { createRouterService, type RouterService } from "../core/service.js";
import type { WrapperLauncher } from "../core/wrapper.js";

export interface CliDependencies {
  createService: (options: {
    routerHome: string;
    workspaceCwd: string;
    pathValue?: string;
  }) => RouterService;
  cwd: string;
  detectLauncher: () => WrapperLauncher;
  updateShellProfile: (routerBinDir: string) => Promise<{
    changed: boolean;
    profilePath?: string;
    reloadCommand?: string;
    skippedReason?: string;
  }>;
  pathValue?: string;
  routerHome: string;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

export function isDirectCliEntry(
  argvEntry: string | undefined,
  moduleUrl: string,
  resolvePath: (value: string) => string = realpathSync,
): boolean {
  if (!argvEntry) {
    return false;
  }

  try {
    return resolvePath(argvEntry) === resolvePath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function defaultLauncher(): WrapperLauncher {
  const entryPath = process.argv[1];
  if (entryPath?.endsWith(".js")) {
    return {
      kind: "node",
      nodePath: process.execPath,
      scriptPath: entryPath,
    };
  }

  if (entryPath?.endsWith(".ts")) {
    return {
      kind: "tsx",
      tsxPath: path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      scriptPath: entryPath,
    };
  }

  return {
    kind: "command",
    command: "codex-router",
  };
}

function defaultDependencies(): CliDependencies {
  return {
    createService: ({ routerHome, workspaceCwd, pathValue }) =>
      createRouterService({
        routerHome,
        workspaceCwd,
        ...(pathValue ? { pathValue } : {}),
    }),
    cwd: process.cwd(),
    detectLauncher: defaultLauncher,
    updateShellProfile,
    routerHome: path.join(os.homedir(), ".codex-router"),
    writeStdout: (value: string) => process.stdout.write(value),
    writeStderr: (value: string) => process.stderr.write(value),
    ...(process.env.PATH ? { pathValue: process.env.PATH } : {}),
  };
}

function formatPercent(value?: number): string {
  return value === undefined ? "unknown" : `${value}%`;
}

function formatRemainingPercent(used?: number): string {
  return used === undefined ? "unknown" : `${Math.max(0, 100 - used)}%`;
}

function formatValue(value?: string): string {
  return value ?? "unknown";
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return Boolean(process.stdout.isTTY);
}

interface ThemeColor {
  fg256: number;
  bold?: boolean;
}

const THEME = {
  header: { fg256: 153, bold: true },
  active: { fg256: 117, bold: true },
  healthy: { fg256: 159, bold: true },
  warning: { fg256: 222, bold: true },
  danger: { fg256: 217, bold: true },
  muted: { fg256: 146 },
  text: { fg256: 255 },
  authReady: { fg256: 123, bold: true },
} satisfies Record<string, ThemeColor>;

function colorize(text: string, color: ThemeColor): string {
  if (!colorEnabled()) {
    return text;
  }

  const prefix = color.bold ? "\u001b[1m" : "";
  return `${prefix}\u001b[38;5;${color.fg256}m${text}\u001b[0m`;
}

function tintPercent(text: string, used?: number): string {
  if (used === undefined) {
    return colorize(text, THEME.muted);
  }

  const remaining = Math.max(0, 100 - used);
  if (remaining <= 20) {
    return colorize(text, THEME.danger);
  }

  if (remaining <= 50) {
    return colorize(text, THEME.warning);
  }

  return colorize(text, THEME.healthy);
}

function tintAuth(text: string, authState: string): string {
  if (authState === "ready") {
    return colorize(text, THEME.authReady);
  }

  if (authState === "needs_login") {
    return colorize(text, THEME.danger);
  }

  return colorize(text, THEME.muted);
}

function tintActive(text: string, active: boolean): string {
  return active ? colorize(text, THEME.active) : colorize(text, THEME.text);
}

function renderStatusTable(statuses: Awaited<ReturnType<RouterService["statusAll"]>>): string {
  const header = [
    colorize(pad("ACTIVE", 8), THEME.header),
    colorize(pad("TAG", 12), THEME.header),
    colorize(pad("5H_LEFT", 10), THEME.header),
    colorize(pad("WEEKLY_LEFT", 13), THEME.header),
    colorize(pad("5H_RESET", 12), THEME.header),
    colorize(pad("WEEKLY_RESET", 14), THEME.header),
    colorize(pad("ACCOUNT", 24), THEME.header),
    colorize(pad("AUTH", 12), THEME.header),
  ].join("");

  const lines = statuses.map((status) =>
    [
      tintActive(pad(status.active ? "*" : "", 8), status.active),
      tintActive(pad(status.tag, 12), status.active),
      tintPercent(pad(formatRemainingPercent(status.snapshot.fiveHourUsedPct), 10), status.snapshot.fiveHourUsedPct),
      tintPercent(
        pad(formatRemainingPercent(status.snapshot.weeklyUsedPct), 13),
        status.snapshot.weeklyUsedPct,
      ),
      colorize(pad(formatValue(status.snapshot.resetIn), 12), THEME.muted),
      colorize(pad(formatValue(status.snapshot.weeklyResetIn), 14), THEME.muted),
      colorize(pad(formatValue(status.accountIdentity), 24), THEME.text),
      tintAuth(pad(status.authState, 12), status.authState),
    ].join(""),
  );

  return `${header}\n${lines.join("\n")}\n`;
}

function renderStatusDetail(status: Awaited<ReturnType<RouterService["statusForTag"]>>): string {
  return [
    `tag: ${status.tag}`,
    `active: ${status.active ? "yes" : "no"}`,
    `five_hour_left_pct: ${formatRemainingPercent(status.snapshot.fiveHourUsedPct)}`,
    `weekly_left_pct: ${formatRemainingPercent(status.snapshot.weeklyUsedPct)}`,
    `five_hour_reset_in: ${formatValue(status.snapshot.resetIn)}`,
    `weekly_reset_in: ${formatValue(status.snapshot.weeklyResetIn)}`,
    `raw_limit_source: ${status.snapshot.rawLimitSource}`,
    `account: ${formatValue(status.accountIdentity)}`,
    `auth_state: ${status.authState}`,
    `auth_storage_path: ${status.authStoragePath}`,
    `last_switch_at: ${formatValue(status.lastSwitchAt)}`,
    `last_status_check_at: ${formatValue(status.lastStatusCheckAt)}`,
  ].join("\n");
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = defaultDependencies(),
): Promise<number> {
  const service = dependencies.createService({
    routerHome: dependencies.routerHome,
    workspaceCwd: dependencies.cwd,
    ...(dependencies.pathValue ? { pathValue: dependencies.pathValue } : {}),
  });

  if (argv[0] === "proxy") {
    return await service.runSelectedCodex(argv.slice(1));
  }

  const program = new Command();
  program
    .name("codex-router")
    .description("Route Codex launches across tagged accounts with shared local context.")
    .exitOverride();

  program
    .command("login")
    .requiredOption("-t, --tag <tag>", "Tag to store the account under")
    .action(async (options: { tag: string }) => {
      const account = await service.login(options.tag);
      dependencies.writeStdout(`Logged in as ${account.tag}\n`);
    });

  program.command("init").action(async () => {
    const result = await service.initWrapper(dependencies.detectLauncher());
    dependencies.writeStdout(`Installed codex wrapper at ${result.wrapperPath}\n`);
    dependencies.writeStdout(`Real codex binary: ${result.realCodexPath}\n`);
    dependencies.writeStdout(`Activate in this shell: ${result.pathHint} && hash -r\n`);
    if (result.bootstrapMessage) {
      const prefix = result.bootstrapStatus === "failed" ? "Warning" : "Bootstrap";
      dependencies.writeStdout(`${prefix}: ${result.bootstrapMessage}\n`);
    }
    const shellProfile = await dependencies.updateShellProfile(path.dirname(result.wrapperPath));

    if (shellProfile.profilePath) {
      dependencies.writeStdout(
        `${shellProfile.changed ? "Updated" : "Verified"} shell profile: ${shellProfile.profilePath}\n`,
      );
      if (shellProfile.reloadCommand) {
        dependencies.writeStdout(`Reload your shell: ${shellProfile.reloadCommand}\n`);
      }
    } else {
      dependencies.writeStdout(`Add to your shell profile: ${result.pathHint}\n`);
      if (shellProfile.skippedReason) {
        dependencies.writeStdout(`${shellProfile.skippedReason}\n`);
      }
    }
  });

  program
    .command("switch")
    .argument("<tag>", "Tag to make active")
    .action(async (tag: string) => {
      const account = await service.switchTo(tag);
      dependencies.writeStdout(`Active tag: ${account.tag}\n`);
    });

  program
    .command("status")
    .option("-t, --tag <tag>", "Show only one tag")
    .action(async (options: { tag?: string }) => {
      if (options.tag) {
        const status = await service.statusForTag(options.tag);
        dependencies.writeStdout(`${renderStatusDetail(status)}\n`);
        return;
      }

      const statuses = await service.statusAll();
      dependencies.writeStdout(renderStatusTable(statuses));
    });

  program.command("current").action(async () => {
    const current = await service.current();
    dependencies.writeStdout(`${current?.tag ?? "none"}\n`);
  });

  program
    .command("del")
    .requiredOption("-t, --tag <tag>", "Tag to delete")
    .action(async (options: { tag: string }) => {
      await service.deleteTag(options.tag);
      dependencies.writeStdout(`Deleted ${options.tag}\n`);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return 0;
    }

    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`${message}\n`);
    return 1;
  }
}

if (isDirectCliEntry(process.argv[1], import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
