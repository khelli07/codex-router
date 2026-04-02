import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { formatResetIn, parseRateLimitsFromJsonLines, parseRateLimitsFromText, type RateLimitSnapshot } from "./status.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
  timeoutLabel?: string;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

export interface CodexAccountSummary {
  email?: string;
  planType?: string;
}

export interface AppServerRequestOptions {
  codexHomeDir: string;
  cwd: string;
  codexCommand?: string;
  method: string;
  params: unknown;
}

export type AppServerRequester = (options: AppServerRequestOptions) => Promise<unknown>;

const COMMAND_TIMEOUT_MS = 30_000;
const APP_SERVER_TIMEOUT_MS = 30_000;

interface RunCodexInput {
  codexHomeDir?: string;
  cwd: string;
  args: string[];
  codexCommand?: string;
  runner?: CommandRunner;
}

interface LoginCodexInput {
  codexHomeDir: string;
  cwd: string;
  codexCommand?: string;
  runner?: CommandRunner;
}

interface ProbeAccountLimitsInput {
  codexHomeDir: string;
  cwd: string;
  codexCommand?: string;
  runner?: CommandRunner;
  appServerRequester?: AppServerRequester;
}

interface ReadCodexAccountInput {
  codexHomeDir: string;
  cwd: string;
  codexCommand?: string;
  appServerRequester?: AppServerRequester;
}

interface AppServerSuccessResponse<T> {
  id: number;
  result: T;
}

interface AppServerErrorResponse {
  id: number;
  error: unknown;
}

interface AppServerAccountResponse {
  account: {
    type: "apiKey" | "chatgpt";
    email?: string;
    planType?: string;
  } | null;
  requiresOpenaiAuth: boolean;
}

interface AppServerRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

interface AppServerRateLimitResponse {
  rateLimits: {
    primary?: AppServerRateLimitWindow | null;
    secondary?: AppServerRateLimitWindow | null;
    planType?: string | null;
  };
}

interface AuthFileShape {
  tokens?: {
    id_token?: string;
  };
}

function buildCommandEnv(codexHomeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: codexHomeDir,
  };
}

function resolveCodexCommand(codexCommand?: string): string {
  return codexCommand ?? "codex";
}

async function defaultRunner(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs;
    const timeout =
      timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            child.kill("SIGTERM");
            reject(
              new Error(
                `${options.timeoutLabel ?? `${command} ${args.join(" ")}`.trim()} timed out after ${
                  Math.ceil(timeoutMs / 1000)
                }s.`,
              ),
            );
          }, timeoutMs)
        : undefined;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function ensureFileAuthConfig(codexHomeDir: string): Promise<void> {
  await mkdir(codexHomeDir, { recursive: true });
  await chmod(codexHomeDir, 0o700);
  const configPath = path.join(codexHomeDir, "config.toml");
  await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', "utf8");
  await chmod(configPath, 0o600);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = parts[1] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeAccountSummary(response: AppServerAccountResponse): CodexAccountSummary | undefined {
  if (response.account?.type !== "chatgpt") {
    return undefined;
  }

  return {
    ...(response.account.email ? { email: response.account.email } : {}),
    ...(response.account.planType ? { planType: response.account.planType } : {}),
  };
}

function normalizeAppServerRateLimits(
  response: AppServerRateLimitResponse,
  now = new Date(),
): RateLimitSnapshot {
  const primary = response.rateLimits.primary ?? undefined;
  const secondary = response.rateLimits.secondary ?? undefined;

  return {
    ...(primary?.usedPercent !== undefined ? { fiveHourUsedPct: primary.usedPercent } : {}),
    ...(secondary?.usedPercent !== undefined ? { weeklyUsedPct: secondary.usedPercent } : {}),
    ...(typeof primary?.resetsAt === "number"
      ? { resetIn: formatResetIn(primary.resetsAt, now) }
      : {}),
    ...(typeof secondary?.resetsAt === "number"
      ? { weeklyResetIn: formatResetIn(secondary.resetsAt, now) }
      : {}),
    rawLimitSource: "app-server account/rateLimits/read",
    ...(response.rateLimits.planType ? { planType: response.rateLimits.planType } : {}),
  };
}

async function defaultAppServerRequester<T>(options: AppServerRequestOptions): Promise<T> {
  await ensureFileAuthConfig(options.codexHomeDir);

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(resolveCodexCommand(options.codexCommand), ["app-server"], {
      cwd: options.cwd,
      env: buildCommandEnv(options.codexHomeDir),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let initialized = false;
    let requestSent = false;
    const initializeId = 1;
    const requestId = 2;

    const timeout = setTimeout(() => {
      finish(() =>
        reject(new Error(`Codex app-server timed out after ${APP_SERVER_TIMEOUT_MS / 1000}s.`)),
      );
    }, APP_SERVER_TIMEOUT_MS);

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
      child.kill("SIGTERM");
    };

    const handleMessage = (line: string): void => {
      let message: AppServerSuccessResponse<T> | AppServerErrorResponse;

      try {
        message = JSON.parse(line) as AppServerSuccessResponse<T> | AppServerErrorResponse;
      } catch {
        return;
      }

      if ("error" in message) {
        finish(() => reject(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)}`)));
        return;
      }

      if (message.id === initializeId) {
        initialized = true;
        if (!requestSent) {
          requestSent = true;
          child.stdin.write(
            `${JSON.stringify({ id: requestId, method: options.method, params: options.params })}\n`,
          );
        }
        return;
      }

      if (initialized && message.id === requestId) {
        finish(() => resolve(message.result));
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();

      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          handleMessage(line);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (exitCode) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            stderrBuffer.trim() ||
              stdoutBuffer.trim() ||
              `Codex app-server exited before responding (code ${exitCode ?? 1}).`,
          ),
        );
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-router",
            title: null,
            version: "1.0.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      })}\n`,
    );
  });
}

async function readAccountSummaryFromAuthFile(codexHomeDir: string): Promise<CodexAccountSummary | undefined> {
  try {
    const raw = await readFile(path.join(codexHomeDir, "auth.json"), "utf8");
    const auth = JSON.parse(raw) as AuthFileShape;
    const payload = auth.tokens?.id_token ? decodeJwtPayload(auth.tokens.id_token) : undefined;
    const email = typeof payload?.email === "string" ? payload.email : undefined;

    return email ? { email } : undefined;
  } catch {
    return undefined;
  }
}

export async function readCodexAccountSummary(
  input: ReadCodexAccountInput,
): Promise<CodexAccountSummary | undefined> {
  const requester = input.appServerRequester ?? defaultAppServerRequester;

  try {
    const response = (await requester({
      codexHomeDir: input.codexHomeDir,
      cwd: input.cwd,
      ...(input.codexCommand ? { codexCommand: input.codexCommand } : {}),
      method: "account/read",
      params: {},
    })) as AppServerAccountResponse;

    return normalizeAccountSummary(response) ?? (await readAccountSummaryFromAuthFile(input.codexHomeDir));
  } catch {
    return await readAccountSummaryFromAuthFile(input.codexHomeDir);
  }
}

export async function runCodex(input: RunCodexInput): Promise<CommandResult> {
  const runner = input.runner ?? defaultRunner;
  const env = input.codexHomeDir ? buildCommandEnv(input.codexHomeDir) : process.env;

  return await runner(resolveCodexCommand(input.codexCommand), input.args, {
    cwd: input.cwd,
    env,
    stdio: "inherit",
  });
}

export async function runCodexLogin(input: LoginCodexInput): Promise<CommandResult> {
  const runner = input.runner ?? defaultRunner;
  await ensureFileAuthConfig(input.codexHomeDir);

  return await runner(resolveCodexCommand(input.codexCommand), ["login"], {
    cwd: input.cwd,
    env: buildCommandEnv(input.codexHomeDir),
    stdio: "inherit",
  });
}

export async function getCodexLoginStatus(input: LoginCodexInput): Promise<CommandResult> {
  const runner = input.runner ?? defaultRunner;
  await ensureFileAuthConfig(input.codexHomeDir);

  return await runner(resolveCodexCommand(input.codexCommand), ["login", "status"], {
    cwd: input.cwd,
    env: buildCommandEnv(input.codexHomeDir),
    stdio: "pipe",
    timeoutLabel: "codex login status",
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

export async function probeAccountLimits(
  input: ProbeAccountLimitsInput,
): Promise<RateLimitSnapshot> {
  const requester = input.appServerRequester ?? defaultAppServerRequester;

  try {
    const response = (await requester({
      codexHomeDir: input.codexHomeDir,
      cwd: input.cwd,
      ...(input.codexCommand ? { codexCommand: input.codexCommand } : {}),
      method: "account/rateLimits/read",
      params: {},
    })) as AppServerRateLimitResponse;

    return normalizeAppServerRateLimits(response);
  } catch {
    // Fall back to the older exec-based probe for Codex versions without app-server rate limits.
  }

  const runner = input.runner ?? defaultRunner;
  const result = await runner(
    resolveCodexCommand(input.codexCommand),
    ["exec", "--json", "--skip-git-repo-check", "Reply with OK only."],
    {
      cwd: input.cwd,
      env: buildCommandEnv(input.codexHomeDir),
      stdio: "pipe",
      timeoutLabel: "codex exec rate-limit probe",
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );

  const structured = parseRateLimitsFromJsonLines(result.stdout);
  if (
    structured.fiveHourUsedPct !== undefined ||
    structured.weeklyUsedPct !== undefined ||
    structured.resetIn !== undefined ||
    structured.weeklyResetIn !== undefined
  ) {
    return structured;
  }

  const textFallback = parseRateLimitsFromText([result.stdout, result.stderr].join("\n"));
  if (
    textFallback.fiveHourUsedPct !== undefined ||
    textFallback.weeklyUsedPct !== undefined ||
    textFallback.resetIn !== undefined ||
    textFallback.weeklyResetIn !== undefined
  ) {
    return textFallback;
  }

  return {
    rawLimitSource: result.stderr.trim() || result.stdout.trim() || "unknown",
  };
}
