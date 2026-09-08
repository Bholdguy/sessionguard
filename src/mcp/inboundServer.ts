/**
 * The MCP server SessionGuard exposes to System 1 (the reference agent).
 * Mirrors the resolved upstream tool surface outward, MINUS the excluded
 * transfer/withdraw/futures/margin tools (SECURITY §5). Every CallTool is handed
 * to `onToolCall` — in Step 1 that is a plain passthrough; from Step 5 it runs
 * the rule pipeline first.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RefusalCode } from "../domain/blockCode.js";
import type { ToolCatalog } from "../domain/types.js";
import { logicalFor } from "./toolCatalog.js";

export interface ToolCallOutcome {
  /** MCP CallTool result content to return to the agent (verbatim upstream response when allowed). */
  result: unknown;
}

export interface InboundDeps {
  catalog: ToolCatalog;
  onToolCall: (params: {
    upstreamToolName: string;
    logicalName: string | null;
    args: Record<string, unknown>;
  }) => Promise<ToolCallOutcome>;
}

function refusal(code: RefusalCode, detail: string) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ refusal: code, detail }) }],
  };
}

export function createInboundServer(deps: InboundDeps): Server {
  const excluded = new Set(deps.catalog.excluded.map((e) => e.name));
  const mirrored = deps.catalog.rawList.filter((t) => !excluded.has(t.name));
  const mirroredNames = new Set(mirrored.map((t) => t.name));

  const server = new Server(
    { name: "sessionguard-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mirrored.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: "object" }) as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const upstreamToolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (excluded.has(upstreamToolName) || !mirroredNames.has(upstreamToolName)) {
      return refusal(
        RefusalCode.UNSUPPORTED_TOOL,
        `Tool "${upstreamToolName}" is not in SessionGuard's allowed catalog (transfer/withdraw/futures/margin are refused).`,
      );
    }

    const logicalName = logicalFor(deps.catalog, upstreamToolName);
    const outcome = await deps.onToolCall({ upstreamToolName, logicalName, args });
    return outcome.result as Record<string, unknown>;
  });

  return server;
}
