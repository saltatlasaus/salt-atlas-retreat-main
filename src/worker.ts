import "@/lib/cf-bindings-worker";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { runInCloudflareEnv } from "@/lib/cf-bindings";
import { runScheduled } from "./lib/pipeline/cron";

const startFetch = createStartHandler(defaultStreamHandler);

export default {
  fetch(request: Request, env: CloudflareEnv, _ctx: ExecutionContext) {
    return runInCloudflareEnv(env, () => startFetch(request));
  },
  async scheduled(controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runInCloudflareEnv(env, () => runScheduled(controller.cron)));
  },
};
