/**
 * The routing mode and the local model's status, for the console's Settings
 * and the status command. Buttons for Will, never tools for a model: nothing a
 * model reads can change the mode. They need the full token (a scoped voice or
 * eval token cannot reach them, ./access).
 *
 *   GET  /inference                              -> the status (./inference-status), after one fresh look at the model server
 *   POST /inference/mode {mode: local|hybrid|cloud}   -> switch, and save the choice; the reply carries the mode
 *                                                    now in force and the two sentences the console shows for it
 *   POST /inference/mode {reset: true}            -> forget the saved choice: back to FLINT_INFERENCE_MODE
 *
 * The body is validated by a strict schema; anything else is a 400 with a
 * sentence. A change is written to the audit trail (from, to, who): of the
 * mode, or of whether the mode in force is a saved one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readJsonLimited } from './attachments';
import { MODES, type InferenceMode } from './inference-config';
import { MODE_SETTERS, ModeNotSaved, type ModeSetter, type ModeStore } from './inference-mode';
import type { InferenceStatus } from './inference-status';

export interface InferenceRouteDeps {
  mode: ModeStore;
  /** The status after a fresh look at the server. */
  status: () => Promise<InferenceStatus>;
  /**
   * What the Mode row and the Local Only row say for the mode now in force (./inference-status), so the console
   * can show a saved mode at once, without waiting for a second request. Left out: the reply carries none.
   */
  sentences?: () => { modeSentence: string; localOnlySentence: string };
  /** A mode change, for the audit trail. */
  audit: (change: { from: InferenceMode; to: InferenceMode; by: ModeSetter; reset: boolean }) => void;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

const Body = z.union([
  z.object({ mode: z.enum(MODES), by: z.enum(MODE_SETTERS).optional() }).strict(),
  z.object({ reset: z.literal(true), by: z.enum(MODE_SETTERS).optional() }).strict(),
]);

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

/** Handle one inference route; false when `url` is not one of them. */
export async function inferenceRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: InferenceRouteDeps): Promise<boolean> {
  const path = url.split('?')[0];
  if (req.method === 'GET' && path === '/inference') {
    try {
      return reply(res, 200, await deps.status());
    } catch (err) {
      return reply(res, 500, { error: 'Flint couldn’t read its status.', ref: deps.errorRef('inference', err) });
    }
  }
  if (req.method === 'POST' && path === '/inference/mode') {
    const read = await readJsonLimited(req, 4096);
    if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
    const body = Body.safeParse(read.body);
    if (!body.success) return reply(res, 400, { error: 'The mode is Local, Hybrid or Cloud.' });
    const by = body.data.by ?? 'console';
    const reset = 'reset' in body.data;
    try {
      const sourceBefore = deps.mode.source();
      const previous = 'reset' in body.data ? deps.mode.reset(by) : deps.mode.set(body.data.mode, by);
      const mode = deps.mode.current();
      // A change of mode, and also a mode that stays the same but is now saved (or no longer): saved, it wins
      // over the environment at the next restart, so that is on the audit trail too (`from` equals `to`).
      if (mode !== previous || deps.mode.source() !== sourceBefore) deps.audit({ from: previous, to: mode, by, reset });
      return reply(res, 200, { ok: true, mode, previous, source: deps.mode.source(), ...(deps.sentences ? deps.sentences() : {}) });
    } catch (err) {
      if (err instanceof ModeNotSaved) return reply(res, 500, { error: 'Flint couldn’t save the mode.' });
      return reply(res, 500, { error: 'Flint couldn’t change the mode.', ref: deps.errorRef('inference', err) });
    }
  }
  return false;
}
