import { afterEach, describe, expect, test, vi } from "vitest";

import { createGuiServer } from "../../src/gui/server.js";
import type { RouterService } from "../../src/core/service.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("GUI server", () => {
  test("serves status JSON and forwards switch actions to the shared service", async () => {
    const service: RouterService = {
      login: vi.fn(),
      switchTo: vi.fn(async () => ({
        tag: "codex-2",
        authStoragePath: "/tmp/codex-2/auth.json",
        authState: "ready" as const,
        createdAt: new Date().toISOString(),
      })),
      current: vi.fn(),
      deleteTag: vi.fn(),
      launch: vi.fn(),
      importDefaultCodexHome: vi.fn(),
      statusAll: vi.fn(async () => [
        {
          tag: "codex-1",
          active: true,
          authState: "ready" as const,
          authStoragePath: "/tmp/codex-1/auth.json",
          snapshot: {
            fiveHourUsedPct: 68,
            weeklyUsedPct: 41,
            resetIn: "14m",
            rawLimitSource: "structured token_count event",
          },
        },
      ]),
      statusForTag: vi.fn(),
    };

    const server = await createGuiServer({ port: 0, service });
    servers.push(server);

    const statusResponse = await fetch(`${server.origin}/api/status`);
    expect(statusResponse.ok).toBe(true);

    const statuses = (await statusResponse.json()) as Array<{ tag: string }>;
    expect(statuses[0]?.tag).toBe("codex-1");

    const switchResponse = await fetch(`${server.origin}/api/switch`, {
      method: "POST",
      body: JSON.stringify({ tag: "codex-2" }),
      headers: {
        "content-type": "application/json",
      },
    });

    expect(switchResponse.ok).toBe(true);
    expect(service.switchTo).toHaveBeenCalledWith("codex-2");
  });
});
