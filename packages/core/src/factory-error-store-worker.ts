import { parentPort, workerData } from "node:worker_threads";
import { captureSidecarRuntimeErrorOwned, type FactoryErrorStoreOptions } from "./factory-error-store.js";

const input = workerData as {
  errorCode: string;
  options: FactoryErrorStoreOptions & { transientObservation?: boolean; nowIso?: string };
};
try {
  const { nowIso, ...options } = input.options;
  parentPort?.postMessage(await captureSidecarRuntimeErrorOwned(input.errorCode, {
    ...options,
    ...(nowIso === undefined ? {} : { now: () => new Date(nowIso) }),
  }));
} catch {
  parentPort?.postMessage({ status: "failed" });
}
