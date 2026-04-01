import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getActiveAccount,
  listAccounts,
  markAccountLaunched,
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
  launchCodex,
  probeAccountLimits,
  readCodexAccountSummary,
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

export interface AccountStatusResult {
  tag: string;
  active: boolean;
  accountIdentity?: string;
  authState: AccountRecord["authState"];
  authStoragePath: string;
  snapshot: RateLimitSnapshot;
  lastSwitchAt?: string;
  lastLaunchAt?: string;
  lastStatusCheckAt?: string;
}

interface CreateRouterServiceInput {
  routerHome: string;
  workspaceCwd: string;
  runner?: CommandRunner;
  appServerRequester?: AppServerRequester;
}

export interface RouterService {
  login(tag: string): Promise<AccountRecord>;
  switchTo(tag: string): Promise<AccountRecord>;
  current(): Promise<AccountRecord | undefined>;
  deleteTag(tag: string): Promise<void>;
  launch(): Promise<void>;
  importDefaultCodexHome(sourceCodexHome?: string): Promise<void>;
  statusAll(): Promise<AccountStatusResult[]>;
  statusForTag(tag: string): Promise<AccountStatusResult>;
}

function toStatusResult(account: AccountRecord, activeTag?: string): AccountStatusResult {
  return {
    tag: account.tag,
    active: account.tag === activeTag,
    authState: account.authState,
    authStoragePath: account.authStoragePath,
    snapshot: account.lastKnownStatus ?? { rawLimitSource: "unknown" },
    ...(account.accountIdentity ? { accountIdentity: account.accountIdentity } : {}),
    ...(account.lastSwitchAt ? { lastSwitchAt: account.lastSwitchAt } : {}),
    ...(account.lastLaunchAt ? { lastLaunchAt: account.lastLaunchAt } : {}),
    ...(account.lastStatusCheckAt ? { lastStatusCheckAt: account.lastStatusCheckAt } : {}),
  };
}

export function createRouterService(input: CreateRouterServiceInput): RouterService {
  const layout = getRouterLayout(input.routerHome);
  const defaultCodexHome = path.join(os.homedir(), ".codex");

  async function getActiveTag(): Promise<string | undefined> {
    const active = await getActiveAccount(layout.registryPath);
    return active?.tag;
  }

  async function seedSharedStateIfNeeded(): Promise<void> {
    await seedSharedStateFromCodexHome({
      sourceCodexHome: defaultCodexHome,
      routerHome: input.routerHome,
    });
  }

  return {
    async login(tag: string): Promise<AccountRecord> {
      await ensureRouterLayout(input.routerHome);
      await seedSharedStateIfNeeded();

      const accountHomeDir = path.join(layout.accountsDir, tag);
      const authStoragePath = path.join(accountHomeDir, "auth.json");

      const result = await runCodexLogin({
        codexHomeDir: accountHomeDir,
        cwd: input.workspaceCwd,
        ...(input.runner ? { runner: input.runner } : {}),
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Codex login failed for ${tag}`);
      }

      await readFile(authStoragePath, "utf8");

      const accountSummary = await readCodexAccountSummary({
        codexHomeDir: accountHomeDir,
        cwd: input.workspaceCwd,
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });

      return await registerAccount(layout.registryPath, {
        tag,
        authStoragePath,
        ...(accountSummary?.email ? { accountIdentity: accountSummary.email } : {}),
      });
    },

    async switchTo(tag: string): Promise<AccountRecord> {
      return await setActiveAccount(layout.registryPath, tag);
    },

    async current(): Promise<AccountRecord | undefined> {
      return await getActiveAccount(layout.registryPath);
    },

    async deleteTag(tag: string): Promise<void> {
      await removeAccount(layout.registryPath, tag);
      await rm(path.join(layout.accountsDir, tag), { force: true, recursive: true });
    },

    async launch(): Promise<void> {
      const active = await getActiveAccount(layout.registryPath);
      if (!active) {
        throw new Error("No active account configured.");
      }

      await seedSharedStateIfNeeded();
      await assembleRuntimeHome({
        routerHome: input.routerHome,
        tag: active.tag,
        authSourcePath: active.authStoragePath,
      });

      const launchResult = await launchCodex({
        runtimeHomeDir: layout.runtimeCurrentHomeDir,
        cwd: input.workspaceCwd,
        ...(input.runner ? { runner: input.runner } : {}),
      });

      if (launchResult.exitCode !== 0) {
        throw new Error(launchResult.stderr || "Codex launch failed.");
      }

      await markAccountLaunched(layout.registryPath, active.tag);
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

      const loginStatus = await getCodexLoginStatus({
        codexHomeDir: path.dirname(account.authStoragePath),
        cwd: input.workspaceCwd,
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
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });
      await setAccountIdentity(layout.registryPath, account.tag, accountSummary?.email);

      const snapshot = await probeAccountLimits({
        codexHomeDir: path.dirname(account.authStoragePath),
        cwd: input.workspaceCwd,
        ...(input.runner ? { runner: input.runner } : {}),
        ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
      });
      const updated = await recordAccountStatusSnapshot(layout.registryPath, account.tag, snapshot);
      const activeTag = await getActiveTag();

      return toStatusResult(updated, activeTag);
    },
  };
}
