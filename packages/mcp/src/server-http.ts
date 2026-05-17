import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildCodexSidecarMcpServer } from "./server.js";

export interface CodexSidecarMcpHttpOptions {
  host: string;
  port: number;
  bearer?: string;
  allowedHosts?: string[];
  path?: string;
}

export interface CodexSidecarMcpHttpServer {
  host: string;
  port: number;
  bearerEnabled: boolean;
  server: Server;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 39201;
const DEFAULT_PATH = "/mcp";

export async function startCodexSidecarMcpHttpServer(
  options: CodexSidecarMcpHttpOptions,
): Promise<CodexSidecarMcpHttpServer> {
  const path = options.path ?? DEFAULT_PATH;
  const bearer = options.bearer && options.bearer.length > 0 ? options.bearer : undefined;
  const sessions = new Map<string, Session>();

  const enableDnsRebindingProtection =
    Array.isArray(options.allowedHosts) && options.allowedHosts.length > 0;
  const allowedHosts = enableDnsRebindingProtection ? options.allowedHosts : undefined;

  async function createSession(): Promise<Session> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection,
      allowedHosts,
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });
    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id) {
        sessions.delete(id);
      }
    };
    const server = buildCodexSidecarMcpServer();
    await server.connect(transport);
    return { transport, server };
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[codex-sidecar:mcp:http] handler error: ${msg}\n`);
      if (!res.headersSent) {
        respondJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: msg }, id: null });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith(path)) {
      respondJson(res, 404, { error: "not found" });
      return;
    }

    if (bearer) {
      const header = req.headers["authorization"];
      const headerValue = Array.isArray(header) ? header[0] : header;
      if (!headerValue || headerValue !== `Bearer ${bearer}`) {
        respondJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if ("error" in body) {
        respondJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: body.error },
          id: null,
        });
        return;
      }

      let session: Session | undefined;
      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          respondJson(res, 404, {
            jsonrpc: "2.0",
            error: { code: -32001, message: "unknown session" },
            id: null,
          });
          return;
        }
      } else if (isInitializeRequest(body.value)) {
        session = await createSession();
      } else {
        respondJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32600, message: "session id required for non-initialize requests" },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(req, res, body.value);
      if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
        sessions.set(session.transport.sessionId, session);
      }
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) {
        respondJson(res, 400, { error: "session id required" });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        respondJson(res, 404, { error: "unknown session" });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    res.statusCode = 405;
    res.setHeader("allow", "POST, GET, DELETE");
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : options.port;

  return {
    host: options.host,
    port: actualPort,
    bearerEnabled: Boolean(bearer),
    server: httpServer,
    async close(): Promise<void> {
      for (const session of sessions.values()) {
        try {
          await session.transport.close();
        } catch {
          // ignore — best effort cleanup
        }
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

export async function startCodexSidecarMcpHttpServerFromEnv(): Promise<CodexSidecarMcpHttpServer> {
  const host = process.env.CODEX_SIDECAR_MCP_HOST ?? DEFAULT_HOST;
  const portRaw = process.env.CODEX_SIDECAR_MCP_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CODEX_SIDECAR_MCP_PORT must be 1..65535; received "${portRaw}"`);
  }
  const bearer = process.env.CODEX_SIDECAR_MCP_BEARER?.trim();
  const allowedHostsRaw = process.env.CODEX_SIDECAR_MCP_ALLOWED_HOSTS;
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : defaultAllowedHosts(host, port);

  return startCodexSidecarMcpHttpServer({
    host,
    port,
    bearer: bearer && bearer.length > 0 ? bearer : undefined,
    allowedHosts,
  });
}

function defaultAllowedHosts(host: string, port: number): string[] {
  const hosts = new Set<string>();
  const portSuffix = `:${port}`;
  hosts.add(`${host}${portSuffix}`);
  hosts.add(host);
  if (host === "0.0.0.0" || host === "::") {
    hosts.add(`127.0.0.1${portSuffix}`);
    hosts.add("127.0.0.1");
    hosts.add(`localhost${portSuffix}`);
    hosts.add("localhost");
  }
  return [...hosts];
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ value: unknown } | { error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 8 * 1024 * 1024;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      return { error: "request body too large" };
    }
    chunks.push(buf);
  }
  if (total === 0) {
    return { value: undefined };
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isInitializeRequest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isInitializeRequest(entry));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const method = (value as { method?: unknown }).method;
  return method === "initialize";
}
