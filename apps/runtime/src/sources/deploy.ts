/**
 * deploy: the install scripts' deploy events (~/.flint/deploy-events.jsonl,
 * one JSON line per failed stage or finished deploy), every minute. Event-only:
 * it raises SourceEvents (gate.failed, migrate.failed, restart.failed,
 * health.failed, deploy.ok) and writes nothing in the world model.
 *
 *  - Read from where it stopped: the cursor is `<offset>:<inode>`, so a file
 *    replaced (a new inode) or cut short is read from its start.
 *  - Each line is held to the shared contract (DeployEvent); one that is not
 *    is set aside and counted, never read as an event.
 *  - Once per component, stage, outcome and sha, however often it is written.
 *  - At most 1 MB a run; a half-written last line waits for the next.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { DeployEvent } from '@flint/policy';
import type { RaisedEvent, Source, SourceRun, SyncResult } from './types.js';

export const DEPLOY_READ_MAX = 1024 * 1024;

export function parseCursor(raw: string | undefined): { offset: number; inode: string } {
  const m = (raw ?? '').match(/^(\d{1,15}):(\d{1,30})$/);
  return m ? { offset: Number(m[1]), inode: m[2]! } : { offset: 0, inode: '' };
}

export function deploySource(o: { file: string }): Source {
  return {
    name: 'deploy',
    cadenceMs: 60_000,
    async run(r: SourceRun): Promise<SyncResult> {
      const prev = parseCursor(r.cursor?.cursor);
      if (!existsSync(o.file)) return { observations: [], metrics: [], events: [], cursor: r.cursor?.cursor ?? '' };
      const st = statSync(o.file);
      const inode = String(st.ino);
      const start = prev.inode === inode && prev.offset <= st.size ? prev.offset : 0;
      const length = Math.min(DEPLOY_READ_MAX, st.size - start);
      const buf = Buffer.alloc(length);
      const fd = openSync(o.file, 'r');
      try {
        readSync(fd, buf, 0, length, start);
      } finally {
        closeSync(fd);
      }
      // Whole lines only: the bytes after the last newline are read next time.
      const end = buf.lastIndexOf(0x0a);
      const text = end >= 0 ? buf.subarray(0, end + 1).toString('utf8') : '';
      const events: RaisedEvent[] = [];
      let malformed = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = DeployEvent.safeParse(JSON.parse(line));
        } catch {
          parsed = undefined;
        }
        if (!parsed?.success) {
          malformed += 1;
          continue;
        }
        const e = parsed.data;
        events.push({
          sourceRef: `${e.component}:${e.stage}:${e.outcome}:${e.sha}`, type: `${e.stage}.${e.outcome}`, occurredAt: new Date(e.at),
          sensitivity: 'ops', tainted: false, payload: { component: e.component, stage: e.stage, outcome: e.outcome, sha: e.sha },
        });
      }
      return {
        observations: [], metrics: [], events,
        cursor: `${start + (end >= 0 ? end + 1 : 0)}:${inode}`,
        ...(malformed ? { errors: [`${malformed} line(s) of deploy-events.jsonl are not deploy events; set aside`] } : {}),
      };
    },
  };
}
