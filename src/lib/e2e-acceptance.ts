/** Pass bar for one resort in the 12-URL studio run. Live URLs stay a manual check. */
export interface E2ESample {
  url: string;
  scrapeRunId?: string;
  usablePages: number;
  facts: Array<{ value: string; quoted: boolean }>;
  exclusivityClearedByHuman: boolean;
  draftStored: boolean;
}

export interface E2EChecks {
  linkedRun: boolean;
  usablePages: boolean;
  quotedFacts: boolean;
  exclusivity: boolean;
  draft: boolean;
}

export function assessSample(sample: E2ESample): { pass: boolean; checks: E2EChecks } {
  const quoted = sample.facts.filter((fact) => fact.quoted).length;
  const ratio = sample.facts.length ? quoted / sample.facts.length : 0;
  const checks: E2EChecks = {
    linkedRun: Boolean(sample.scrapeRunId),
    usablePages: sample.usablePages > 0,
    quotedFacts: sample.facts.length > 0 && ratio >= 0.5,
    exclusivity: sample.exclusivityClearedByHuman,
    draft: sample.draftStored,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
