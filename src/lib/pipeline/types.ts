export type PipelineJobKind = "chat" | "daily";

export type PipelineJobStatus =
  | "idle"
  | "waiting_apify"
  | "running"
  | "paused_budget"
  | "done"
  | "failed";

export type PipelineStage = "discover" | "scrape" | "research" | "generate" | "review" | "published";

export type PipelineMessageRole = "user" | "assistant" | "status";

export interface PipelineJob {
  id: string;
  kind: PipelineJobKind;
  status: PipelineJobStatus;
  stage: PipelineStage;
  instruction: string;
  day: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface PipelineTarget {
  id: string;
  jobId: string;
  resortKey: string;
  name: string;
  url: string;
  stage: PipelineStage;
  scrapeRunId?: string;
  updatedAt: string;
}

export interface PipelineMessage {
  id: string;
  jobId: string;
  role: PipelineMessageRole;
  content: string;
  createdAt: string;
}

export interface PipelineFact {
  id: string;
  targetId: string;
  key: string;
  value: string;
  sourceUrl: string;
  createdAt: string;
}

export interface PipelineDraftSection {
  title: string;
  body: string;
}

export interface PipelineDraft {
  id: string;
  targetId: string;
  title: string;
  sections: PipelineDraftSection[];
  r2Key?: string;
  createdAt: string;
}

export interface PipelineScrapeProgress {
  runId: string;
  apifyRunId: string;
  status: string;
  itemCount: number;
  simulated: boolean;
  targetNames: string[];
}

export interface PipelineBoard {
  spendGbp: number;
  capGbp: number;
  model: string;
  jobs: PipelineJob[];
  job?: PipelineJob;
  messages: PipelineMessage[];
  targets: PipelineTarget[];
  facts: PipelineFact[];
  drafts: Array<{ id: string; targetId: string; title: string; r2Key?: string }>;
  scrapeProgress: PipelineScrapeProgress[];
  note?: string;
}
