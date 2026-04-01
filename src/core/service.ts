import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getActiveAccount,
  listAccounts,
  recordAccountStatusSnapshot,
  registerAccount,
  removeAccount,
  setAccountIdentity,
  setAccountAuthState,
  setActiveAccount,
  type AccountRecord,
} from "./accounts.js";
import {
  getCodexLoginStatus,
  probeAccountLimits,
  readCodexAccountSummary,
  runCodex,
  type AppServerRequester,
  runCodexLogin,
  type CommandRunner,
} from "./codex.js";
import { getRouterLayout } from "./paths.js";
import {
  assembleRuntimeHome,
  ensureRouterLayout,
  importSharedState,
  seedSharedStateFromCodexHome,
} from "./runtime-home.js";
import type { RateLimitSnapshot } from "./status.js";
import {
  findRealCodexPath,
  installCodexWrapper,
  resolveConfiguredCodexPath,
  type WrapperInstallResult,
  type WrapperLauncher,
} from "./wrapper.js";

export interface AccountStatusResult {
  tag: string;
  active: boolean;
  accountIdentity?: string;
  authState: AccountRecord["authState"];
  authStoragePath: string;
  snapshot: RateLimitSnapshot;
  lastSwitchAt?: string;
  lastStatusCheckAt?: string;
}

interface CreateRouterServiceInput {
  routerHome: string;
  workspaceCwd: string;
  pathValue?: string;
  runner?: CommandRunner;
  appServerRequester?: AppServerRequester;
}

export interface RouterService {
  login(tag: string): Promise<AccountRecord>;
  initWrapper(launcher: WrapperLauncher): Promise<WrapperInstallResult>;
  runSelectedCodex(args: string[]): Promise<number>;
  switchTo(tag: string): Promise<AccountRecord>;
  current(): Promise<AccountRecord | undefined>;
  deleteTag(tag: string): Promise<void>;
  importDefaultCodexHome(sourceCodexHome?: string): Promise<void>;
  statusAll(): Promise<AccountStatusResult[]>;
  statusForTag(tag: string): Promise<AccountStatusResult>;
}

const ACCOUNT_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function toStatusResult(account: AccountRecord, activeTag?: string): AccountStatusResult {
  return {
    tag: account.tag,
    active: account.tag === activeTag,
    authState: account.authState,
    authStoragePath: account.authStoragePath,
    snapshot: account.lastKnownStatus ?? { rawLimitSource: "unknown" },
    ...(account.accountIdentity ? { accountIdentity: account.accountIdentity } : {}),
    ...(account.lastSwitchAt ? { lastSwitchAt: account.lastSwitchAt } : {}),
    ...(account.lastStatusCheckAt ? { lastStatusCheckAt: account.lastStatusCheckAt } : {}),
  };
}

function validateAccountTag(tag: string): void {
  if (!ACCOUNT_TAG_PATTERN.test(tag)) {
    throw new Error(
      `Invalid account tag: ${tag}. Tags may only contain letters, numbers, dot, underscore, and dash.`,
    );
  }
}

function getAccountHomeDir(accountsDir: string, tag: string): string {
  validateAccountTag(tag);
  return path.join(accountsDir, tag);
}

export function createRouterService(input: CreateRouterServiceInput): RouterService {
  const layout = getRouterLayout(input.routerHome);
  const defaultCodexHome = path.join(os.homedir(), ".codex");

  async function getActiveTag(): Promise<string | undefined> {
    const active = await getActiveAccount(layout.registryPath);
    return active?.tag;
  }

  async function seedSharedStateIfNeeded(): Promise<void> {
    try {
      await seedSharedStateFromCodexHome({
        sourceCodexHome: defaultCodexHome,
        routerHome: input.routerHome,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Cannot import from the router-managed runtime home")) {
        throw error;
      }
    }
  }

  async function getCodexCommand(): Promise<string> {
    if (process.env.CODEX_ROUTER_REAL_CODEX) {
      return process.env.CODEX_ROUTER_REAL_CODEX;
    }

    return (await resolveConfiguredCodexPath(input.routerHome)) ?? "codex";
  }

  return {
    async login(tag: string): Promise<AccountRecord> {
      await ensureRouterLayout(input.routerHome);
      await seedSharedStateIfNeeded();
      const codexCommand = await getCodexCommand();

      const accountHomeDir = getAccountHomeDir(layout.accountsDir, tag);
      const authStoragePath = path.join(accountHomeDir, "auth.json");

      const result = await runCodexLogin({
        codexHomeDir: accountHomeDir,
        cwd: input.workspaceCwd,
        codexCommand,
        ...(input.runner ? { runner: input.runner } : {}),
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Codex login failed for ${tag}`);
      }

      await readFile(authStoragePath, "utf8");

      const accountSummary = await readCodexAccountSummary({
        codexHomeDir: accountHomeDir,
        cwd: input.workspaceCwd,
        codexCommand,
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });

      return await registerAccount(layout.registryPath, {
        tag,
        authStoragePath,
        ...(accountSummary?.email ? { accountIdentity: accountSummary.email } : {}),
      });
    },

    async initWrapper(launcher: WrapperLauncher): Promise<WrapperInstallResult> {
      await ensureRouterLayout(input.routerHome);
      const realCodexPath = await findRealCodexPath(input.routerHome, input.pathValue);
      return await installCodexWrapper(input.routerHome, realCodexPath, launcher);
    },

    async runSelectedCodex(args: string[]): Promise<number> {
      const codexCommand = await getCodexCommand();
      const active = await getActiveAccount(layout.registryPath);

      if (!active) {
        const result = await runCodex({
          cwd: input.workspaceCwd,
          args,
          codexCommand,
          ...(input.runner ? { runner: input.runner } : {}),
        });
        return result.exitCode;
      }

      await seedSharedStateIfNeeded();
      await assembleRuntimeHome({
        routerHome: input.routerHome,
        tag: active.tag,
        authSourcePath: active.authStoragePath,
      });

      const result = await runCodex({
        codexHomeDir: layout.runtimeCurrentHomeDir,
        cwd: input.workspaceCwd,
        args,
        codexCommand,
        ...(input.runner ? { runner: input.runner } : {}),
      });
      return result.exitCode;
    },

    async switchTo(tag: string): Promise<AccountRecord> {
      return await setActiveAccount(layout.registryPath, tag);
    },

    async current(): Promise<AccountRecord | undefined> {
      return await getActiveAccount(layout.registryPath);
    },

    async deleteTag(tag: string): Promise<void> {
      const accountHomeDir = getAccountHomeDir(layout.accountsDir, tag);
      await removeAccount(layout.registryPath, tag);
      await rm(accountHomeDir, { force: true, recursive: true });
    },

    async importDefaultCodexHome(sourceCodexHome = path.join(os.homedir(), ".codex")): Promise<void> {
      await importSharedState({
        sourceCodexHome,
        routerHome: input.routerHome,
      });
    },

    async statusAll(): Promise<AccountStatusResult[]> {
      const accounts = await listAccounts(layout.registryPath);
      const refreshed: AccountStatusResult[] = [];
      for (const account of accounts) {
        refreshed.push(await this.statusForTag(account.tag));
      }
      const activeTag = await getActiveTag();

      return refreshed.sort((left, right) => Number(right.tag === activeTag) - Number(left.tag === activeTag));
    },

    async statusForTag(tag: string): Promise<AccountStatusResult> {
      const accounts = await listAccounts(layout.registryPath);
      const account = accounts.find((entry) => entry.tag === tag);
      if (!account) {
        throw new Error(`Unknown account tag: ${tag}`);
      }
      const codexCommand = await getCodexCommand();

      const loginStatus = await getCodexLoginStatus({
        codexHomeDir: path.dirname(account.authStoragePath),
        cwd: input.workspaceCwd,
        codexCommand,
        ...(input.runner ? { runner: input.runner } : {}),
      });
      const authState = loginStatus.exitCode === 0 ? "ready" : "needs_login";
      await setAccountAuthState(layout.registryPath, account.tag, authState);

      if (authState !== "ready") {
        const refreshedAccounts = await listAccounts(layout.registryPath);
        const refreshed = refreshedAccounts.find((entry) => entry.tag === tag);
        if (!refreshed) {
          throw new Error(`Unknown account tag: ${tag}`);
        }

        const activeTag = await getActiveTag();
        return toStatusResult(refreshed, activeTag);
      }

      const accountSummary = await readCodexAccountSummary({
        codexHomeDir: path.dirname(account.authStoragePath),
        cwd: input.workspaceCwd,
        codexCommand,
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });
      await setAccountIdentity(layout.registryPath, account.tag, accountSummary?.email);

      const snapshot = await probeAccountLimits({
        codexHomeDir: path.dirname(account.authStoragePath),
        cwd: input.workspaceCwd,
        codexCommand,
        ...(input.runner ? { runner: input.runner } : {}),
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });
      const updated = await recordAccountStatusSnapshot(layout.registryPath, account.tag, snapshot);
      const activeTag = await getActiveTag();

      return toStatusResult(updated, activeTag);
    },
  };
}
