/**
 * Mount an MCP low-level Server on an Express app over stateful Streamable HTTP.
 * Shared by the SessionGuard inbound proxy server and by test/mockUpstream.
 *
 * A fresh MCP `Server` instance is built per Streamable-HTTP session (via
 * `opts.createServer`). The MCP SDK forbids connecting one `Server`/`Protocol`
 * to more than one transport, so reusing a single instance across connections
 * throws "Already connected to a transport" on the second client's initialize
 * and crashes the process.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface MountedMcp {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function mountMcpServer(opts: {
  /** builds a NEW MCP Server per Streamable-HTTP session (see file header) */
  createServer: () => Server;
  port: number;
  host?: string;
  path?: string;
  /** optional bearer gate — returns 401 unless `Authorization: Bearer <token>` matches (Step 2 test) */
  requireBearer?: string;
}): Promise<MountedMcp> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  if (opts.requireBearer) {
    app.use(path, (req, res, next) => {
      if (req.headers.authorization === `Bearer ${opts.requireBearer}`) return next();
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "401 Unauthorized: bad or missing bearer token" },
        id: null,
      });
    });
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(path, async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid MCP session" },
          id: null,
        });
        return;
      }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string): void => {
          transports.set(id, t);
        },
      });
      const mcpServer = opts.createServer();
      await mcpServer.connect(t);
      // chain after the SDK's own onclose (set by connect) so the session is
      // evicted and its Server torn down when the client disconnects
      const sdkOnClose = t.onclose;
      t.onclose = () => {
        sdkOnClose?.();
        if (t.sessionId) transports.delete(t.sessionId);
        void mcpServer.close();
      };
      transport = t;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionScoped = async (req: express.Request, res: express.Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(400).send("no valid MCP session");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get(path, sessionScoped);
  app.delete(path, sessionScoped);

  const httpServer: HttpServer = await new Promise((resolve) => {
    const s = app.listen(opts.port, host, () => resolve(s));
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    url: `http://${host}:${port}${path}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of transports.values()) void t.close();
        httpServer.close(() => resolve());
        // drop keep-alive / SSE sockets so close() doesn't wait for their idle timeout
        httpServer.closeAllConnections?.();
      }),
  };
}
