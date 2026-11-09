import { modelFor, usdCost } from "../agents/models";
import { dbFirst, dbRun, utcDay } from "./db";

const USD_TO_GBP = 0.78;

/** GBP for a call. Defaults to the pipeline role's model so pricing follows ANTHROPIC_MODEL_PIPELINE. */
export function costGbp(inputTokens: number, outputTokens: number, model: string = modelFor("pipeline")): number {
  return usdCost(model, inputTokens, outputTokens) * USD_TO_GBP;
}

export function dailyCapGbp(): number {
  const raw = process.env["PIPELINE_DAILY_BUDGET_GBP"]?.trim();
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function anthropicModel(): string {
  return modelFor("pipeline");
}

export async function spendTodayGbp(): Promise<number> {
  const row = await dbFirst<{ gbp: number }>(`SELECT gbp FROM pipeline_spend WHERE day = ?`, [utcDay()]);
  return Number(row?.gbp ?? 0);
}

/** Running Claude total across every stored day. */
export async function spendTotalGbp(): Promise<number> {
  const row = await dbFirst<{ gbp: number }>(`SELECT COALESCE(SUM(gbp), 0) AS gbp FROM pipeline_spend`);
  return Number(row?.gbp ?? 0);
}

export async function addSpendGbp(gbp: number): Promise<number> {
  if (gbp <= 0) return spendTodayGbp();
  const day = utcDay();
  await dbRun(
    `INSERT INTO pipeline_spend (day, gbp) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET gbp = gbp + excluded.gbp`,
    [day, gbp],
  );
  return spendTodayGbp();
}

export async function budgetRemainingGbp(): Promise<number> {
  return Math.max(0, dailyCapGbp() - (await spendTodayGbp()));
}
