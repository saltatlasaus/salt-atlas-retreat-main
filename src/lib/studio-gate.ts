import { createServerFn } from "@tanstack/react-start";

export const studioGateStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { studioGateStatus: status } = await import("./studio-gate.server");
  return status();
});

export const unlockStudio = createServerFn({ method: "POST" })
  .validator((data: { password?: string }) => ({ password: (data?.password ?? "").trim() }))
  .handler(async ({ data }) => {
    const { unlockStudio: unlock } = await import("./studio-gate.server");
    return unlock(data.password);
  });

export const lockStudio = createServerFn({ method: "POST" }).handler(async () => {
  const { lockStudio: lock } = await import("./studio-gate.server");
  return lock();
});
