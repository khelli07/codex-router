#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRouterService, type RouterService } from "../core/service.js";

export interface CliDependencies {
  createService: (options: { routerHome: string; workspaceCwd: string }) => RouterService;
  cwd: string;
  routerHome: string;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

function defaultDependencies(): CliDependencies {
  return {
    createService: ({ routerHome, workspaceCwd }) =>
      createRouterService({
        routerHome,
        workspaceCwd,
      }),
    cwd: process.cwd(),
    routerHome: path.join(os.homedir(), ".codex-router"),
    writeStdout: (value: string) => process.stdout.write(value),
    writeStderr: (value: string) => process.stderr.write(value),
  };
}

function formatPercent(value?: number): string {
  return value === undefined ? "unknown" : `${value}%`;
}

function formatValue(value?: string): string {
  return value ?? "unknown";
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function renderStatusTable(statuses: Awaited<ReturnType<RouterService["statusAll"]>>): string {
  const header = [
    pad("ACTIVE", 8),
    pad("TAG", 12),
    pad("5H_USED", 10),
    pad("WEEKLY_USED", 13),
    pad("RESET_IN", 12),
    pad("ACCOUNT", 24),
    pad("AUTH", 12),
  ].join("");

  const lines = statuses.map((status) =>
    [
      pad(status.active ? "*" : "", 8),
      pad(status.tag, 12),
      pad(formatPercent(status.snapshot.fiveHourUsedPct), 10),
      pad(formatPercent(status.snapshot.weeklyUsedPct), 13),
      pad(formatValue(status.snapshot.resetIn), 12),
      pad(formatValue(status.accountIdentity), 24),
      pad(status.authState, 12),
    ].join(""),
  );

  return `${header}\n${lines.join("\n")}\n`;
}

function renderStatusDetail(status: Awaited<ReturnType<RouterService["statusForTag"]>>): string {
  return [
    `tag: ${status.tag}`,
    `active: ${status.active ? "yes" : "no"}`,
    `five_hour_used_pct: ${formatPercent(status.snapshot.fiveHourUsedPct)}`,
    `weekly_used_pct: ${formatPercent(status.snapshot.weeklyUsedPct)}`,
    `reset_in: ${formatValue(status.snapshot.resetIn)}`,
    `raw_limit_source: ${status.snapshot.rawLimitSource}`,
    `account: ${formatValue(status.accountIdentity)}`,
    `auth_state: ${status.authState}`,
    `auth_storage_path: ${status.authStoragePath}`,
    `last_switch_at: ${formatValue(status.lastSwitchAt)}`,
    `last_launch_at: ${formatValue(status.lastLaunchAt)}`,
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
  });

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

  program.command("launch").action(async () => {
    await service.launch();
    dependencies.writeStdout("Launched Codex\n");
  });

  program
    .command("import")
    .option("-s, --source <path>", "Path to an existing CODEX_HOME")
    .action(async (options: { source?: string }) => {
      await service.importDefaultCodexHome(options.source);
      dependencies.writeStdout("Imported shared Codex state\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
