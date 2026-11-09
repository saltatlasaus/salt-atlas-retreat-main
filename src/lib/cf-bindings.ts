/**
 * Cloudflare Worker bindings (D1, R2) for shared server code.
 * Real AsyncLocalStorage is registered from `cf-bindings-worker.ts` (Worker entry only).
 * In the browser / Vitest without init, `getCloudflareEnv` is always undefined → local fallbacks.
 */

interface CfEnvStorage {
  get(): CloudflareEnv | undefined;
  run<T>(env: CloudflareEnv, fn: () => T): T;
}

const noop: CfEnvStorage = {
  get: () => undefined,
  run: (_env, fn) => fn(),
};

let impl: CfEnvStorage = noop;

/** Called once from the Worker entry — never import the worker init from client code. */
export function setCfBindingsStorage(next: CfEnvStorage): void {
  impl = next;
}

export function getCloudflareEnv(): CloudflareEnv | undefined {
  return impl.get();
}

export function runInCloudflareEnv<T>(env: CloudflareEnv, fn: () => T): T {
  return impl.run(env, fn);
}
