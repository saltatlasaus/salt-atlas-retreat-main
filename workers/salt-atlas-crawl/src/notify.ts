// Teams alerts, in the same Adaptive Card format as the Facebook leads Worker.
// Optional: if TEAMS_WEBHOOK_URL is not set, alerts are skipped (everything is still in D1).

import type { Env } from './types.ts';

export async function postToTeams(env: Env, title: string, facts: [string, string][], attention = false, note?: string): Promise<void> {
  if (!env.TEAMS_WEBHOOK_URL) return;
  const body: unknown[] = [
    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true, ...(attention ? { color: 'Attention' } : {}) },
    { type: 'FactSet', facts: facts.map(([t, v]) => ({ title: t, value: v })) },
  ];
  if (note) body.push({ type: 'TextBlock', text: note, wrap: true, isSubtle: true });
  try {
    const res = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body },
        }],
      }),
    });
    if (!res.ok) console.error('Teams webhook failed', res.status, await res.text());
  } catch (e) {
    console.error('Teams webhook error', e);
  }
}
