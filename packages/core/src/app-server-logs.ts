import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SidecarRequest } from "./types.js";

export type AppServerLogDirection = "inbound" | "outbound";

export interface AppServerLogEntry {
  timestamp: string;
  category: "lifecycle" | "protocol" | "stderr" | "diagnostic";
  event: string;
  direction?: AppServerLogDirection;
  data?: unknown;
}

export interface AppServerEventLogger {
  readonly ref: string;
  write(entry: Omit<AppServerLogEntry, "timestamp">): void;
  close(): Promise<void>;
}

export interface AppServerEventLogOptions {
  logDir?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export const DEFAULT_APP_SERVER_LOG_DIR = ".codex-sidecar/logs/app-server";

export async function createAppServerEventLogger(
  request: SidecarRequest,
  options: AppServerEventLogOptions = {},
): Promise<AppServerEventLogger> {
  const logDir = options.logDir ?? join(request.projectRoot, DEFAULT_APP_SERVER_LOG_DIR);
  await mkdir(logDir, { recursive: true });

  const startedAt = (options.now ?? (() => new Date()))();
  const runId = sanitizeFilePart((options.idFactory ?? randomUUID)());
  const fileName = `${formatTimestampForFile(startedAt)}-${request.workflow}-${runId}.jsonl`;
  const filePath = join(logDir, fileName);
  const stream = createWriteStream(filePath, { flags: "wx", encoding: "utf8" });

  return new JsonlAppServerEventLogger(filePath, stream, options.now);
}

class JsonlAppServerEventLogger implements AppServerEventLogger {
  readonly ref: string;

  constructor(
    filePath: string,
    private readonly stream: WriteStream,
    private readonly now: (() => Date) | undefined,
  ) {
    this.ref = filePath;
  }

  write(entry: Omit<AppServerLogEntry, "timestamp">): void {
    this.stream.write(`${JSON.stringify({ timestamp: this.timestamp(), ...entry })}\n`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private timestamp(): string {
    return (this.now ?? (() => new Date()))().toISOString();
  }
}

function formatTimestampForFile(date: Date): string {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "");
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}
