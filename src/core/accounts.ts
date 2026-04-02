import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccountAuthState = "ready" | "needs_login" | "invalid" | "unknown";

export interface AccountStatusSnapshot {
  fiveHourUsedPct?: number;
  weeklyUsedPct?: number;
  resetIn?: string;
  weeklyResetIn?: string;
  rawLimitSource: string;
  planType?: string;
}

export interface AccountRecord {
  tag: string;
  authStoragePath: string;
  accountIdentity?: string;
  authState: AccountAuthState;
  createdAt: string;
  lastSwitchAt?: string;
  lastStatusCheckAt?: string;
  lastKnownStatus?: AccountStatusSnapshot;
}

interface AccountRegistry {
  activeTag?: string;
  accounts: AccountRecord[];
}

interface RegisterAccountInput {
  tag: string;
  authStoragePath: string;
  accountIdentity?: string;
}

const DEFAULT_REGISTRY: AccountRegistry = {
  accounts: [],
};

async function ensureRegistryDirectory(registryPath: string): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  await chmod(path.dirname(registryPath), 0o700);
}

async function loadRegistry(registryPath: string): Promise<AccountRegistry> {
  try {
    const raw = await readFile(registryPath, "utf8");
    return JSON.parse(raw) as AccountRegistry;
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return structuredClone(DEFAULT_REGISTRY);
    }

    throw error;
  }
}

async function saveRegistry(registryPath: string, registry: AccountRegistry): Promise<void> {
  await ensureRegistryDirectory(registryPath);
  const tempPath = `${registryPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await chmod(tempPath, 0o600);
  await rename(tempPath, registryPath);
}

function requireAccount(registry: AccountRegistry, tag: string): AccountRecord {
  const account = registry.accounts.find((entry) => entry.tag === tag);

  if (!account) {
    throw new Error(`Unknown account tag: ${tag}`);
  }

  return account;
}

function now(): string {
  return new Date().toISOString();
}

export async function listAccounts(registryPath: string): Promise<AccountRecord[]> {
  const registry = await loadRegistry(registryPath);
  return registry.accounts;
}

export async function getActiveAccount(registryPath: string): Promise<AccountRecord | undefined> {
  const registry = await loadRegistry(registryPath);
  return registry.accounts.find((entry) => entry.tag === registry.activeTag);
}

export async function registerAccount(
  registryPath: string,
  input: RegisterAccountInput,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const existing = registry.accounts.find((entry) => entry.tag === input.tag);

  if (existing) {
    existing.authStoragePath = input.authStoragePath;
    existing.authState = "ready";
    if (input.accountIdentity) {
      existing.accountIdentity = input.accountIdentity;
    }
    await saveRegistry(registryPath, registry);
    return existing;
  }

  const account: AccountRecord = {
    tag: input.tag,
    authStoragePath: input.authStoragePath,
    authState: "ready",
    createdAt: now(),
    ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
  };

  registry.accounts.push(account);

  if (!registry.activeTag) {
    registry.activeTag = account.tag;
    account.lastSwitchAt = now();
  }

  await saveRegistry(registryPath, registry);
  return account;
}

export async function setActiveAccount(
  registryPath: string,
  tag: string,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const account = requireAccount(registry, tag);

  registry.activeTag = tag;
  account.lastSwitchAt = now();

  await saveRegistry(registryPath, registry);
  return account;
}

export async function removeAccount(registryPath: string, tag: string): Promise<void> {
  const registry = await loadRegistry(registryPath);

  if (registry.activeTag === tag) {
    throw new Error(`Cannot delete active account: ${tag}`);
  }

  const nextAccounts = registry.accounts.filter((entry) => entry.tag !== tag);

  if (nextAccounts.length === registry.accounts.length) {
    throw new Error(`Unknown account tag: ${tag}`);
  }

  registry.accounts = nextAccounts;
  await saveRegistry(registryPath, registry);
}

export async function markAccountStatusChecked(
  registryPath: string,
  tag: string,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const account = requireAccount(registry, tag);

  account.lastStatusCheckAt = now();
  await saveRegistry(registryPath, registry);

  return account;
}

export async function recordAccountStatusSnapshot(
  registryPath: string,
  tag: string,
  snapshot: AccountStatusSnapshot,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const account = requireAccount(registry, tag);

  account.lastKnownStatus = snapshot;
  account.lastStatusCheckAt = now();
  await saveRegistry(registryPath, registry);

  return account;
}

export async function setAccountAuthState(
  registryPath: string,
  tag: string,
  authState: AccountAuthState,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const account = requireAccount(registry, tag);

  account.authState = authState;
  account.lastStatusCheckAt = now();
  await saveRegistry(registryPath, registry);

  return account;
}

export async function setAccountIdentity(
  registryPath: string,
  tag: string,
  accountIdentity?: string,
): Promise<AccountRecord> {
  const registry = await loadRegistry(registryPath);
  const account = requireAccount(registry, tag);

  if (accountIdentity === undefined) {
    delete account.accountIdentity;
  } else {
    account.accountIdentity = accountIdentity;
  }
  await saveRegistry(registryPath, registry);

  return account;
}
