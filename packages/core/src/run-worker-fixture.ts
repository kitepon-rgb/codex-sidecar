import { runWorker } from "./run-worker.js";
await runWorker(process.argv[2]!, async (signal) => {
  if (process.env.FIXTURE_HANG === "1") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}, { heartbeatIntervalMs: Number(process.env.FIXTURE_HEARTBEAT_MS ?? 1_000) });
