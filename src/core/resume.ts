import { readdir } from "node:fs/promises";
import path from "node:path";

export async function hasResumeCandidate(runtimeHomeDir: string): Promise<boolean> {
  const sessionsDir = path.join(runtimeHomeDir, "sessions");

  try {
    const entries = await readdir(sessionsDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}
