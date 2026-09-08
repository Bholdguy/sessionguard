/**
 * MCP client SessionGuard uses to reach the Binance Agent OS MCP server
 * (or MockUpstream). Attaches the bearer token (D-4); classifies 401/403 as
 * AuthError so the fail-closed path (Step 7a) can consume it. Optional
 * single-shot refresh; default is hard fail-closed on any 401/403.
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
  /**
   * Optional single-shot refresh (D-4). Token refresh semantics are NOT
   * documented by Binance, so the default is: no refresh, any 401/403 is a
   * hard fail-closed and the operator must re-authenticate. If provided, it is
   * attempted at most once per failing call; still failing -> AuthError.
   */
  refresh?: (() => Promise<string | null>) | undefined;
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

function isAuth(e: unknown): boolean {
  const m = errMsg(e);
  return /\b(401|403)\b/.test(m) || /unauthor/i.test(m) || /forbidden/i.test(m);
}

export function createUpstreamClient(cfg: UpstreamClientConfig): UpstreamClient {
  assertTransportAllowed(cfg);

  let token = cfg.bearerToken;
  let client = build();
  let refreshed = false;

  function build(): Client {
    const c = new Client({ name: "sessionguard", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    (c as unknown as { __transport: StreamableHTTPClientTransport }).__transport = transport;
    return c;
  }

  function transportOf(c: Client): StreamableHTTPClientTransport {
    return (c as unknown as { __transport: StreamableHTTPClientTransport }).__transport;
  }

  async function connectFresh(): Promise<void> {
    client = build();
    await client.connect(transportOf(client));
  }

  /** Run `op`; on a 401/403, try one refresh + reconnect + retry (D-4), else AuthError. */
  async function guarded<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (!isAuth(e)) throw e instanceof Error ? e : new Error(errMsg(e));
      if (cfg.refresh && !refreshed) {
        refreshed = true;
        const next = await cfg.refresh().catch(() => null);
        if (next) {
          token = next;
          await connectFresh();
          try {
            return await op();
          } catch (e2) {
            throw new AuthError(`upstream auth rejected after refresh: ${errMsg(e2)}`);
          }
        }
      }
      throw new AuthError(`upstream auth rejected: ${errMsg(e)}`);
    }
  }

  return {
    async connect() {
      try {
        await client.connect(transportOf(client));
      } catch (e) {
        if (!isAuth(e)) throw e instanceof Error ? e : new Error(errMsg(e));
        if (cfg.refresh && !refreshed) {
          refreshed = true;
          const next = await cfg.refresh().catch(() => null);
          if (next) {
            token = next;
            try {
              await connectFresh();
              return;
            } catch (e2) {
              throw new AuthError(`upstream auth rejected after refresh: ${errMsg(e2)}`);
            }
          }
        }
        throw new AuthError(`upstream auth rejected: ${errMsg(e)}`);
      }
    },
    async listTools() {
      return guarded(async () => {
        const res = await client.listTools();
        return res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object" },
        }));
      });
    },
    async callTool(name, args) {
      return guarded(() => client.callTool({ name, arguments: args }));
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
