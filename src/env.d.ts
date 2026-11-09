/** Cloudflare Worker bindings (R2 + D1). Generated further via `bun run cf-typegen`. */
interface CloudflareEnv {
  SCRAPE_BUCKET: R2Bucket;
  DB: D1Database;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}

declare module "cloudflare:workers" {
  const env: CloudflareEnv;
  export { env };
}

declare module "*?raw" {
  const content: string;
  export default content;
}
