import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RouterService } from "../core/service.js";

interface CreateGuiServerInput {
  port: number;
  service: RouterService;
}

export interface GuiServerHandle {
  origin: string;
  close: () => Promise<void>;
}

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export async function createGuiServer(input: CreateGuiServerInput): Promise<GuiServerHandle> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/status") {
        const tag = url.searchParams.get("tag");
        if (tag) {
          writeJson(response, 200, await input.service.statusForTag(tag));
          return;
        }

        writeJson(response, 200, await input.service.statusAll());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/switch") {
        const body = (await readJsonBody(request)) as { tag?: string };
        if (!body.tag) {
          writeJson(response, 400, { error: "Missing tag" });
          return;
        }

        writeJson(response, 200, await input.service.switchTo(body.tag));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/launch") {
        await input.service.launch();
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(path.join(STATIC_DIR, "index.html"), "utf8");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      response.writeHead(404);
      response.end("Not found");
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(input.port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind GUI server");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}
