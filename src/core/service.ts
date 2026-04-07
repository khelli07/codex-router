import { chmod, readFile, rm, stat } from "node:fs/promises";
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
  isSharedStateEmpty,
  persistRuntimeStateToShared,
} from "./runtime-home.js";
import type { RateLimitSnapshot } from "./status.js";
import type { AccountAuthState } from "./accounts.js";
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
  statusAll(): Promise<AccountStatusResult[]>;
  statusForTag(tag: string): Promise<AccountStatusResult>;
}

const ACCOUNT_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUS_PROBE_CONCURRENCY = 4;

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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await mapper(values[currentIndex]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

export function createRouterService(input: CreateRouterServiceInput): RouterService {
  const layout = getRouterLayout(input.routerHome);
  const defaultCodexHome = path.join(os.homedir(), ".codex");

  async function directoryExists(targetPath: string): Promise<boolean> {
    try {
      return (await stat(targetPath)).isDirectory();
    } catch (error) {
      const asNodeError = error as NodeJS.ErrnoException;
      if (asNodeError.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  async function getActiveTag(): Promise<string | undefined> {
    const active = await getActiveAccount(layout.registryPath);
    return active?.tag;
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

      try {
        await readFile(authStoragePath, "utf8");
      } catch {
        throw new Error(
          `Login completed but auth file not found at ${authStoragePath}. ` +
          `The codex version may not support file-based auth storage.`,
        );
      }
      await chmod(authStoragePath, 0o600);

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
      const installed = await installCodexWrapper(input.routerHome, realCodexPath, launcher);

      if (!(await isSharedStateEmpty(input.routerHome))) {
        return {
          ...installed,
          bootstrapStatus: "skipped",
          bootstrapMessage: "Shared state already initialized; bootstrap import skipped.",
        };
      }

      if (!(await directoryExists(defaultCodexHome))) {
        return {
          ...installed,
          bootstrapStatus: "skipped",
          bootstrapMessage: `No existing Codex home found at ${defaultCodexHome}; starting with router-managed shared state.`,
        };
      }

      try {
        await importSharedState({
          sourceCodexHome: defaultCodexHome,
          routerHome: input.routerHome,
        });
        return {
          ...installed,
          bootstrapStatus: "imported",
          bootstrapMessage: `Imported shared non-auth state from ${defaultCodexHome}.`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...installed,
          bootstrapStatus: "failed",
          bootstrapMessage: `Wrapper installed, but shared-state bootstrap import failed: ${message}`,
        };
      }
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

      await assembleRuntimeHome({
        routerHome: input.routerHome,
        tag: active.tag,
        authSourcePath: active.authStoragePath,
      });

      try {
        const result = await runCodex({
          codexHomeDir: layout.runtimeCurrentHomeDir,
          cwd: input.workspaceCwd,
          args,
          codexCommand,
          ...(input.runner ? { runner: input.runner } : {}),
        });
        return result.exitCode;
      } finally {
        await persistRuntimeStateToShared(input.routerHome);
      }
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

    async statusAll(): Promise<AccountStatusResult[]> {
      const accounts = await listAccounts(layout.registryPath);
      const codexCommand = await getCodexCommand();

      const probeResults = await mapWithConcurrency(
        accounts,
        STATUS_PROBE_CONCURRENCY,
        async (account) => {
          const codexHomeDir = path.dirname(account.authStoragePath);
          const loginStatus = await getCodexLoginStatus({
            codexHomeDir,
            cwd: input.workspaceCwd,
            codexCommand,
            ...(input.runner ? { runner: input.runner } : {}),
          });
          const authState: AccountAuthState = loginStatus.exitCode === 0 ? "ready" : "needs_login";

          if (authState !== "ready") {
            return { tag: account.tag, authState, email: undefined, snapshot: undefined };
          }

          const [accountSummary, snapshot] = await Promise.all([
            readCodexAccountSummary({
              codexHomeDir,
              cwd: input.workspaceCwd,
              codexCommand,
              ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
            }),
            probeAccountLimits({
              codexHomeDir,
              cwd: input.workspaceCwd,
              codexCommand,
              ...(input.runner ? { runner: input.runner } : {}),
              ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
            }),
          ]);

          return { tag: account.tag, authState, email: accountSummary?.email, snapshot };
        },
      );

      for (const result of probeResults) {
        await setAccountAuthState(layout.registryPath, result.tag, result.authState);
        if (result.authState === "ready") {
          await setAccountIdentity(layout.registryPath, result.tag, result.email);
          if (result.snapshot) {
            await recordAccountStatusSnapshot(layout.registryPath, result.tag, result.snapshot);
          }
        }
      }

      const refreshedAccounts = await listAccounts(layout.registryPath);
      const activeTag = await getActiveTag();
      return refreshedAccounts
        .map((account) => toStatusResult(account, activeTag))
        .sort((left, right) => Number(right.active) - Number(left.active));
    },

    async statusForTag(tag: string): Promise<AccountStatusResult> {
      const accounts = await listAccounts(layout.registryPath);
      const account = accounts.find((entry) => entry.tag === tag);
      if (!account) {
        throw new Error(`Unknown account tag: ${tag}`);
      }
      const codexCommand = await getCodexCommand();
      const codexHomeDir = path.dirname(account.authStoragePath);

      const loginStatus = await getCodexLoginStatus({
        codexHomeDir,
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

      const [accountSummary, snapshot] = await Promise.all([
        readCodexAccountSummary({
          codexHomeDir,
          cwd: input.workspaceCwd,
          codexCommand,
          ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
        }),
        probeAccountLimits({
          codexHomeDir,
          cwd: input.workspaceCwd,
          codexCommand,
          ...(input.runner ? { runner: input.runner } : {}),
          ...(input.appServerRequester ? { appServerRequester: input.appServerRequester } : {}),
        }),
      ]);
      await setAccountIdentity(layout.registryPath, account.tag, accountSummary?.email);
      const updated = await recordAccountStatusSnapshot(layout.registryPath, account.tag, snapshot);
      const activeTag = await getActiveTag();

      return toStatusResult(updated, activeTag);
    },
  };
}
