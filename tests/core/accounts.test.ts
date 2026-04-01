import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  getActiveAccount,
  listAccounts,
  markAccountStatusChecked,
  recordAccountStatusSnapshot,
  registerAccount,
  removeAccount,
  setActiveAccount,
  setAccountAuthState,
} from "../../src/core/accounts.js";

const tempDirs: string[] = [];

async function makeRegistryPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-router-accounts-"));
  tempDirs.push(dir);
  return path.join(dir, "accounts.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("account registry", () => {
  test("registers the first account and makes it active", async () => {
    const registryPath = await makeRegistryPath();

    const account = await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });

    expect(account.tag).toBe("codex-1");

    const active = await getActiveAccount(registryPath);
    expect(active?.tag).toBe("codex-1");

    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      activeTag: string;
      accounts: Array<{ tag: string }>;
    };

    expect(persisted.activeTag).toBe("codex-1");
    expect(persisted.accounts.map((entry) => entry.tag)).toEqual(["codex-1"]);
  });

  test("switches the active account without changing other tags", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });
    await registerAccount(registryPath, {
      tag: "codex-2",
      authStoragePath: "/tmp/codex-2/auth.json",
    });

    const switched = await setActiveAccount(registryPath, "codex-2");

    expect(switched.tag).toBe("codex-2");
    expect(switched.lastSwitchAt).toBeTruthy();

    const active = await getActiveAccount(registryPath);
    expect(active?.tag).toBe("codex-2");

    const allAccounts = await listAccounts(registryPath);
    expect(allAccounts.map((account) => account.tag)).toEqual(["codex-1", "codex-2"]);
  });

  test("refuses to delete the active tag", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });

    await expect(removeAccount(registryPath, "codex-1")).rejects.toThrow(
      /active account/i,
    );
  });

  test("removes inactive tags and keeps the remaining account", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });
    await registerAccount(registryPath, {
      tag: "codex-2",
      authStoragePath: "/tmp/codex-2/auth.json",
    });

    await removeAccount(registryPath, "codex-2");

    const allAccounts = await listAccounts(registryPath);
    expect(allAccounts.map((account) => account.tag)).toEqual(["codex-1"]);
  });

  test("tracks status refresh timestamps separately from switches", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });

    const checked = await markAccountStatusChecked(registryPath, "codex-1");

    expect(checked.lastStatusCheckAt).toBeTruthy();

    const active = await getActiveAccount(registryPath);
    expect(active?.lastStatusCheckAt).toBeTruthy();
  });

  test("records the last observed limit snapshot for a tag", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });

    const updated = await recordAccountStatusSnapshot(registryPath, "codex-1", {
      fiveHourUsedPct: 17,
      weeklyUsedPct: 66,
      resetIn: "44m",
      rawLimitSource: "structured token_count event",
    });

    expect(updated.lastKnownStatus?.fiveHourUsedPct).toBe(17);
    expect(updated.lastKnownStatus?.weeklyUsedPct).toBe(66);
    expect(updated.lastKnownStatus?.resetIn).toBe("44m");
    expect(updated.lastStatusCheckAt).toBeTruthy();
  });

  test("updates the auth state for a tag", async () => {
    const registryPath = await makeRegistryPath();

    await registerAccount(registryPath, {
      tag: "codex-1",
      authStoragePath: "/tmp/codex-1/auth.json",
    });

    const updated = await setAccountAuthState(registryPath, "codex-1", "needs_login");

    expect(updated.authState).toBe("needs_login");
  });
});
