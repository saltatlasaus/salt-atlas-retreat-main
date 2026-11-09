/**
 * Default matches `.dev.vars.example`. The server gate reads `AGENT_PER_CALL_APPROVAL_GBP` in
 * `agent-server.ts` (Worker has env). Vite does not expose arbitrary env keys to the browser, so
 * UI copy uses this constant unless you add a matching `VITE_` var later.
 */
export const AGENT_PER_CALL_APPROVAL_GBP_DEFAULT = 0.4;
