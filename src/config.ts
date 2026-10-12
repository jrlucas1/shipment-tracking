export interface Config {
  port: number;
  databasePath: string;
  aggregatorBaseUrl: string;
  aggregatorTimeoutMs: number;
  delayLimitHours: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    port: positiveInteger(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH ?? "shipments.db",
    aggregatorBaseUrl: env.AGGREGATOR_BASE_URL ?? "http://localhost:4000",
    aggregatorTimeoutMs: positiveInteger(env, "AGGREGATOR_TIMEOUT_MS", 5000),
    delayLimitHours: positiveInteger(env, "DELAY_LIMIT_HOURS", 168),
  };
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
