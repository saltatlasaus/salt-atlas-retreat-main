import { AsyncLocalStorage } from "node:async_hooks";
import { setCfBindingsStorage } from "./cf-bindings";

const cfEnvStorage = new AsyncLocalStorage<CloudflareEnv>();

setCfBindingsStorage({
  get: () => cfEnvStorage.getStore(),
  run: (env, fn) => cfEnvStorage.run(env, fn),
});
