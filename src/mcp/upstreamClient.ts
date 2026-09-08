/**
 * MCP client SessionGuard uses to reach the Binance Agent OS MCP server
 * (or MockUpstream). Attaches the bearer token (D-4); classifies 401/403 as
 * AuthError so the fail-closed path (Step 7a) can consume it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errMsg } from "../util/timeout.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface UpstreamClient {
  connect(): Promise<void>;
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface UpstreamClientConfig {
  url: string;
  bearerToken?: string | undefined;
  nodeEnv?: string | undefined;
}

function assertTransportAllowed(cfg: UpstreamClientConfig): void {
  if (/^https:\/\//i.test(cfg.url)) return;
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(cfg.url);
  const localModeOk = cfg.nodeEnv === "test" || cfg.nodeEnv === "demo";
  if (isLoopback && localModeOk) return;
  throw new Error(
    `upstreamClient: refusing non-HTTPS upstream ${JSON.stringify(cfg.url)} ` +
      `(loopback http allowed only when NODE_ENV is test|demo)`,
  );
}

function classify(e: unknown): never {
  const m = errMsg(e);
  if (/\b(401|403)\b/.test(m) || /unauthor/i.test(m) || /forbidden/i.test(m)) {
    throw new AuthError(`upstream auth rejected: ${m}`);
  }
  throw e instanceof Error ? e : new Error(m);
}

export function createUpstreamClient(cfg: UpstreamClientConfig): UpstreamClient {
  assertTransportAllowed(cfg);

  const client = new Client({ name: "sessionguard", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.bearerToken
      ? { headers: { Authorization: `Bearer ${cfg.bearerToken}` } }
      : undefined,
  });

  return {
    async connect() {
      try {
        await client.connect(transport);
      } catch (e) {
        classify(e);
      }
    },
    async listTools() {
      try {
        const res = await client.listTools();
        return res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object" },
        }));
      } catch (e) {
        classify(e);
      }
    },
    async callTool(name, args) {
      try {
        return await client.callTool({ name, arguments: args });
      } catch (e) {
        classify(e);
      }
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
