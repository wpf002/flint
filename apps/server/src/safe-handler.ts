import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Wrap an async request handler so a thrown error answers THAT request with a
 * 500 instead of killing the process. The server used to call `void handle(...)`:
 * any rejection was unhandled, which Node treats as fatal. One local-brain
 * "Tool loop exceeded 6 iterations" restarted Flint and failed every in-flight
 * request as a bare "fetch failed" — for every user, not just the one who asked.
 */
export function safeHandler(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  log: (msg: string, err: unknown) => void = (m, e) => console.error(m, e),
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`[http] ${req.method ?? '?'} ${req.url ?? '?'} failed:`, err);
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else {
        // Mid-stream (SSE): say so in-band, then close.
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`);
        } catch {
          /* socket already gone */
        }
        res.end();
      }
    });
  };
}
