import { dbAll, dbFirst, dbRun, newId, nowIso, utcDay } from "./db";
import type {
  PipelineDraft,
  PipelineDraftSection,
  PipelineFact,
  PipelineJob,
  PipelineJobKind,
  PipelineJobStatus,
  PipelineMessage,
  PipelineMessageRole,
  PipelineStage,
  PipelineTarget,
} from "./types";

function opt(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return String(value);
}

function rowJob(row: Record<string, unknown>): PipelineJob {
  const errorMessage = opt(row["error_message"]);
  return {
    id: String(row["id"]),
    kind: String(row["kind"]) as PipelineJobKind,
    status: String(row["status"]) as PipelineJobStatus,
    stage: String(row["stage"]) as PipelineStage,
    instruction: String(row["instruction"]),
    day: String(row["day"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function rowTarget(row: Record<string, unknown>): PipelineTarget {
  const scrapeRunId = opt(row["scrape_run_id"]);
  return {
    id: String(row["id"]),
    jobId: String(row["job_id"]),
    resortKey: String(row["resort_key"]),
    name: String(row["name"]),
    url: String(row["url"]),
    stage: String(row["stage"]) as PipelineStage,
    updatedAt: String(row["updated_at"]),
    ...(scrapeRunId ? { scrapeRunId } : {}),
  };
}

function rowMessage(row: Record<string, unknown>): PipelineMessage {
  return {
    id: String(row["id"]),
    jobId: String(row["job_id"]),
    role: String(row["role"]) as PipelineMessageRole,
    content: String(row["content"]),
    createdAt: String(row["created_at"]),
  };
}

function rowFact(row: Record<string, unknown>): PipelineFact {
  return {
    id: String(row["id"]),
    targetId: String(row["target_id"]),
    key: String(row["fact_key"]),
    value: String(row["value"]),
    sourceUrl: String(row["source_url"]),
    createdAt: String(row["created_at"]),
  };
}

function rowDraft(row: Record<string, unknown>): PipelineDraft {
  const r2Key = opt(row["r2_key"]);
  let sections: PipelineDraftSection[] = [];
  try {
    sections = JSON.parse(String(row["sections_json"])) as PipelineDraftSection[];
  } catch {
    sections = [];
  }
  return {
    id: String(row["id"]),
    targetId: String(row["target_id"]),
    title: String(row["title"]),
    sections,
    createdAt: String(row["created_at"]),
    ...(r2Key ? { r2Key } : {}),
  };
}

export async function createJob(input: {
  kind: PipelineJobKind;
  instruction: string;
  stage?: PipelineStage;
}): Promise<PipelineJob> {
  const now = nowIso();
  const job: PipelineJob = {
    id: newId("job"),
    kind: input.kind,
    status: "idle",
    stage: input.stage ?? "discover",
    instruction: input.instruction,
    day: utcDay(),
    createdAt: now,
    updatedAt: now,
  };
  await dbRun(
    `INSERT INTO pipeline_jobs (
      id, kind, status, stage, instruction, day, created_at, updated_at, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [job.id, job.kind, job.status, job.stage, job.instruction, job.day, job.createdAt, job.updatedAt],
  );
  return job;
}

export async function getJob(id: string): Promise<PipelineJob | undefined> {
  const row = await dbFirst<Record<string, unknown>>(`SELECT * FROM pipeline_jobs WHERE id = ?`, [id]);
  return row ? rowJob(row) : undefined;
}

export async function listJobs(): Promise<PipelineJob[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_jobs ORDER BY created_at DESC LIMIT 40`,
  );
  return rows.map(rowJob);
}

export async function listJobsByStatus(status: PipelineJobStatus): Promise<PipelineJob[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_jobs WHERE status = ? ORDER BY updated_at ASC LIMIT 20`,
    [status],
  );
  return rows.map(rowJob);
}

export async function latestOpenChatJob(): Promise<PipelineJob | undefined> {
  const row = await dbFirst<Record<string, unknown>>(
    `SELECT * FROM pipeline_jobs
     WHERE kind = 'chat' AND status IN ('idle', 'running', 'waiting_apify', 'paused_budget')
     ORDER BY created_at DESC LIMIT 1`,
  );
  return row ? rowJob(row) : undefined;
}

export async function openDailyJob(): Promise<PipelineJob | undefined> {
  const row = await dbFirst<Record<string, unknown>>(
    `SELECT * FROM pipeline_jobs
     WHERE kind = 'daily' AND status NOT IN ('done', 'failed')
     ORDER BY created_at DESC LIMIT 1`,
  );
  return row ? rowJob(row) : undefined;
}

export async function patchJob(
  id: string,
  patch: Partial<Pick<PipelineJob, "status" | "stage" | "errorMessage">>,
): Promise<PipelineJob | undefined> {
  const cur = await getJob(id);
  if (!cur) return undefined;
  const next: PipelineJob = {
    ...cur,
    ...patch,
    updatedAt: nowIso(),
  };
  if (patch.errorMessage === undefined) {
    /* keep */
  }
  await dbRun(
    `UPDATE pipeline_jobs
     SET status = ?, stage = ?, error_message = ?, updated_at = ?
     WHERE id = ?`,
    [next.status, next.stage, next.errorMessage ?? null, next.updatedAt, id],
  );
  return next;
}

export async function addMessage(
  jobId: string,
  role: PipelineMessageRole,
  content: string,
): Promise<PipelineMessage> {
  const message: PipelineMessage = {
    id: newId("msg"),
    jobId,
    role,
    content: content.slice(0, 8000),
    createdAt: nowIso(),
  };
  await dbRun(
    `INSERT INTO pipeline_messages (id, job_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    [message.id, message.jobId, message.role, message.content, message.createdAt],
  );
  return message;
}

export async function listMessages(jobId: string): Promise<PipelineMessage[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_messages WHERE job_id = ? ORDER BY created_at ASC LIMIT 80`,
    [jobId],
  );
  return rows.map(rowMessage);
}

export async function listTargets(): Promise<PipelineTarget[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_targets ORDER BY updated_at DESC LIMIT 80`,
  );
  return rows.map(rowTarget);
}

export async function listTargetsForJob(jobId: string): Promise<PipelineTarget[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_targets WHERE job_id = ? ORDER BY updated_at ASC LIMIT 40`,
    [jobId],
  );
  return rows.map(rowTarget);
}

export async function listOpenTargets(): Promise<PipelineTarget[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_targets WHERE stage NOT IN ('published', 'review') ORDER BY updated_at ASC LIMIT 40`,
  );
  return rows.map(rowTarget);
}

async function syncResort(target: PipelineTarget): Promise<void> {
  try {
    await dbRun(
      `INSERT INTO resorts (resort_key, name, url, stage, scrape_run_id, source, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pipeline', ?)
       ON CONFLICT(resort_key) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         stage = excluded.stage,
         scrape_run_id = excluded.scrape_run_id,
         updated_at = excluded.updated_at`,
      [target.resortKey, target.name, target.url, target.stage, target.scrapeRunId ?? null, target.updatedAt],
    );
  } catch (err) {
    console.warn("[resorts] sync skipped", err instanceof Error ? err.message : err);
  }
}

/** Idle when work remains, review when only a person can publish, done when every target is published. */
export async function settleJob(jobId: string): Promise<void> {
  const targets = await listTargetsForJob(jobId);
  const open = targets.filter((target) => target.stage !== "published" && target.stage !== "review");
  if (open.length) {
    await patchJob(jobId, { status: "idle" });
    return;
  }
  if (targets.some((target) => target.stage === "review")) {
    await patchJob(jobId, { status: "idle", stage: "review" });
    return;
  }
  if (targets.length) await patchJob(jobId, { status: "done", stage: "published" });
}

export async function getTarget(id: string): Promise<PipelineTarget | undefined> {
  const row = await dbFirst<Record<string, unknown>>(`SELECT * FROM pipeline_targets WHERE id = ?`, [id]);
  return row ? rowTarget(row) : undefined;
}

export async function insertTarget(input: {
  jobId: string;
  resortKey: string;
  name: string;
  url: string;
}): Promise<PipelineTarget> {
  const target: PipelineTarget = {
    id: newId("tgt"),
    jobId: input.jobId,
    resortKey: input.resortKey,
    name: input.name,
    url: input.url,
    stage: "discover",
    updatedAt: nowIso(),
  };
  await dbRun(
    `INSERT INTO pipeline_targets (
      id, job_id, resort_key, name, url, stage, scrape_run_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [target.id, target.jobId, target.resortKey, target.name, target.url, target.stage, target.updatedAt],
  );
  await syncResort(target);
  return target;
}

export async function patchTarget(
  id: string,
  patch: Partial<Pick<PipelineTarget, "stage" | "scrapeRunId">>,
): Promise<void> {
  const cur = await getTarget(id);
  if (!cur) return;
  const stage = patch.stage ?? cur.stage;
  const scrapeRunId = patch.scrapeRunId === undefined ? (cur.scrapeRunId ?? null) : patch.scrapeRunId;
  const updatedAt = nowIso();
  await dbRun(`UPDATE pipeline_targets SET stage = ?, scrape_run_id = ?, updated_at = ? WHERE id = ?`, [
    stage,
    scrapeRunId,
    updatedAt,
    id,
  ]);
  await syncResort({
    ...cur,
    stage,
    updatedAt,
    ...(scrapeRunId ? { scrapeRunId } : {}),
  });
}

export async function listFactsForTargets(targetIds: string[]): Promise<PipelineFact[]> {
  if (!targetIds.length) return [];
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_facts ORDER BY created_at DESC LIMIT 200`,
  );
  const wanted = new Set(targetIds);
  return rows.map(rowFact).filter((f) => wanted.has(f.targetId));
}

export async function insertFact(input: {
  targetId: string;
  key: string;
  value: string;
  sourceUrl: string;
}): Promise<PipelineFact> {
  const fact: PipelineFact = {
    id: newId("fact"),
    targetId: input.targetId,
    key: input.key,
    value: input.value,
    sourceUrl: input.sourceUrl,
    createdAt: nowIso(),
  };
  await dbRun(
    `INSERT INTO pipeline_facts (id, target_id, fact_key, value, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fact.id, fact.targetId, fact.key, fact.value, fact.sourceUrl, fact.createdAt],
  );
  return fact;
}

export async function listDrafts(): Promise<PipelineDraft[]> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT * FROM pipeline_drafts ORDER BY created_at DESC LIMIT 40`,
  );
  return rows.map(rowDraft);
}

export async function latestDraft(targetId: string): Promise<PipelineDraft | undefined> {
  const row = await dbFirst<Record<string, unknown>>(
    `SELECT * FROM pipeline_drafts WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`,
    [targetId],
  );
  return row ? rowDraft(row) : undefined;
}

export async function insertDraft(input: {
  targetId: string;
  title: string;
  sections: PipelineDraftSection[];
  r2Key?: string;
}): Promise<PipelineDraft> {
  const draft: PipelineDraft = {
    id: newId("draft"),
    targetId: input.targetId,
    title: input.title,
    sections: input.sections,
    createdAt: nowIso(),
    ...(input.r2Key ? { r2Key: input.r2Key } : {}),
  };
  await dbRun(
    `INSERT INTO pipeline_drafts (id, target_id, title, sections_json, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [draft.id, draft.targetId, draft.title, JSON.stringify(draft.sections), draft.r2Key ?? null, draft.createdAt],
  );
  return draft;
}

export function resortKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "resort";
}
