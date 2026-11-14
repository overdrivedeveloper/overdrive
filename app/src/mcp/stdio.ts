import { createInterface } from "node:readline";
import type { McpServer } from "./server";

const MAX_LINE = 1_000_000;

/** Newline-delimited JSON-RPC over stdio. Only protocol messages go to `write`; logs belong on stderr. */
export async function runStdio(
  server: McpServer, lines: AsyncIterable<string>, write: (line: string) => void, callerKey: string,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const job = (async () => {
      let parsed: unknown;
      if (line.length > MAX_LINE) { write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } })); return; }
      try { parsed = JSON.parse(line); }
      catch { write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })); return; }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of batch) {
        const response = await server.handle(message, callerKey);
        if (response) write(JSON.stringify(response));
      }
    })().finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
}

/** Lines from stdin (or any stream). A line over 1 MB is delivered as is; runStdio answers it with a size error. */
export function stdinLines(stream: NodeJS.ReadableStream = process.stdin): AsyncIterable<string> {
  return createInterface({ input: stream, crlfDelay: Infinity });
}
