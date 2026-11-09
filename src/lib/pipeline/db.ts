import { getCloudflareEnv } from "@/lib/cf-bindings";

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function pipelineDb(): D1Database {
  try {
    const env = getCloudflareEnv();
    if (!env?.DB) throw new Error("D1 binding DB is not available");
    return env.DB;
  } catch (err) {
    if (err instanceof Error && err.message.includes("D1 binding")) throw err;
    throw new Error("D1 binding DB is not available");
  }
}

export function pipelineBucket(): R2Bucket {
  try {
    const env = getCloudflareEnv();
    if (!env?.SCRAPE_BUCKET) throw new Error("R2 binding SCRAPE_BUCKET is not available");
    return env.SCRAPE_BUCKET;
  } catch (err) {
    if (err instanceof Error && err.message.includes("SCRAPE_BUCKET")) throw err;
    throw new Error("R2 binding SCRAPE_BUCKET is not available");
  }
}

type SqlParam = string | number | null;

export async function dbAll<T extends Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const { results } = await pipelineDb().prepare(sql).bind(...params).all<T>();
  return results ?? [];
}

export async function dbFirst<T extends Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const row = await pipelineDb().prepare(sql).bind(...params).first<T>();
  return row ?? null;
}

export async function dbRun(sql: string, params: SqlParam[] = []): Promise<void> {
  await pipelineDb().prepare(sql).bind(...params).run();
}
