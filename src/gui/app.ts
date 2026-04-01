import os from "node:os";
import path from "node:path";

import { createRouterService } from "../core/service.js";
import { createGuiServer } from "./server.js";

const routerHome = path.join(os.homedir(), ".codex-router");
const workspaceCwd = process.cwd();

const service = createRouterService({
  routerHome,
  workspaceCwd,
});

const server = await createGuiServer({
  port: 4035,
  service,
});

process.stdout.write(`codex-router GUI running at ${server.origin}\n`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await new Promise(() => undefined);
