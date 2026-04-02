export interface RateLimitSnapshot {
  fiveHourUsedPct?: number;
  weeklyUsedPct?: number;
  resetIn?: string;
  weeklyResetIn?: string;
  rawLimitSource: string;
  planType?: string;
}

interface JsonRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface JsonRateLimitPayload {
  primary?: JsonRateLimitWindow;
  secondary?: JsonRateLimitWindow;
  plan_type?: string;
}

interface JsonRateLimitEvent {
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: JsonRateLimitPayload;
  };
  rate_limits?: JsonRateLimitPayload;
}

export function formatResetIn(resetsAtSeconds: number, now = new Date()): string {
  const deltaSeconds = Math.max(0, resetsAtSeconds - Math.floor(now.getTime() / 1000));
  const totalMinutes = Math.floor(deltaSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    if (minutes === 0 && remainingHours === 0) {
      return `${days}d`;
    }

    if (minutes === 0) {
      return `${days}d ${remainingHours}h`;
    }

    if (remainingHours === 0) {
      return `${days}d ${minutes}m`;
    }

    return `${days}d ${remainingHours}h`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

function normalizeStructuredRateLimits(
  rateLimits: JsonRateLimitPayload,
  now: Date,
): RateLimitSnapshot {
  const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean) as JsonRateLimitWindow[];
  const fiveHour = windows.find((window) => window.window_minutes === 300);
  const weekly = windows.find((window) => window.window_minutes === 10_080);

  return {
    ...(fiveHour?.used_percent !== undefined ? { fiveHourUsedPct: fiveHour.used_percent } : {}),
    ...(weekly?.used_percent !== undefined ? { weeklyUsedPct: weekly.used_percent } : {}),
    ...(typeof fiveHour?.resets_at === "number"
      ? { resetIn: formatResetIn(fiveHour.resets_at, now) }
      : {}),
    ...(typeof weekly?.resets_at === "number"
      ? { weeklyResetIn: formatResetIn(weekly.resets_at, now) }
      : {}),
    rawLimitSource: "structured token_count event",
    ...(rateLimits.plan_type ? { planType: rateLimits.plan_type } : {}),
  };
}

export function parseRateLimitsFromJsonLines(
  output: string,
  now = new Date(),
): RateLimitSnapshot {
  let latestRateLimits: JsonRateLimitPayload | undefined;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed) as JsonRateLimitEvent;
      const rateLimits = event.rate_limits ?? event.payload?.rate_limits;

      if (rateLimits) {
        latestRateLimits = rateLimits;
      }
    } catch {
      // Ignore non-JSON lines mixed into command output.
    }
  }

  if (!latestRateLimits) {
    return {
      rawLimitSource: "no structured rate limit data",
    };
  }

  return normalizeStructuredRateLimits(latestRateLimits, now);
}

function parsePercent(pattern: RegExp, text: string): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? undefined : value;
}

export function parseRateLimitsFromText(text: string): RateLimitSnapshot {
  const fiveHourUsedPct = parsePercent(/5(?:-hour| hour|h)\D+(\d{1,3})%/i, text);
  const weeklyUsedPct = parsePercent(/weekly\D+(\d{1,3})%/i, text);
  const resetMatch = text.match(/reset(?:s)?(?: in)?\s+([0-9]+[dhm](?:\s+[0-9]+[hm])*)/i);
  const weeklyResetMatch = text.match(/weekly\s+reset(?:s)?(?: in)?\s+([0-9]+[dhm](?:\s+[0-9]+[hm])*)/i);

  return {
    ...(fiveHourUsedPct !== undefined ? { fiveHourUsedPct } : {}),
    ...(weeklyUsedPct !== undefined ? { weeklyUsedPct } : {}),
    ...(resetMatch?.[1] ? { resetIn: resetMatch[1] } : {}),
    ...(weeklyResetMatch?.[1] ? { weeklyResetIn: weeklyResetMatch[1] } : {}),
    rawLimitSource: "text fallback",
  };
}
