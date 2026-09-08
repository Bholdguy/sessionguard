/**
 * Forward an ALLOWED call to the upstream byte-for-byte and return the upstream
 * response unmodified (INV-9). Fill parsing (Step 3) hooks in via `onResult`.
 */
import type { UpstreamClient } from "./upstreamClient.js";

export interface ForwardHooks {
  /** Post-forward hook — Step 3 parses fills here. Errors here must not corrupt the response. */
  onResult?: (upstreamToolName: string, args: Record<string, unknown>, result: unknown) => void | Promise<void>;
}

export async function forward(
  upstream: UpstreamClient,
  upstreamToolName: string,
  args: Record<string, unknown>,
  hooks: ForwardHooks = {},
): Promise<unknown> {
  const result = await upstream.callTool(upstreamToolName, args);
  if (hooks.onResult) {
    try {
      await hooks.onResult(upstreamToolName, args, result);
    } catch {
      // A fill-parse failure is handled inside the hook (fail closed on state),
      // never by discarding the upstream response the agent is waiting on.
    }
  }
  return result;
}
