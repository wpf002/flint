import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One captured interaction — a training example for Flint's own future brain. */
export interface TrainingRecord {
  ts: number;
  id: number;
  conversationId: string;
  brain: 'local' | 'frontier';
  model: string;
  /** What Will actually asked (raw, without injected context). */
  input: string;
  /** The answer Flint gave. When brain === 'frontier' this is the TEACHER
   *  signal — Claude's answer, the target we want Flint's own model to learn. */
  output: string;
  /** Tools used to derive the answer (how, not just what). */
  tools: Array<{ tool: string; outcome?: string; ms?: number }>;
  usage?: unknown;
}

/**
 * The seed of Flint's own brain. Every interaction is appended (JSONL) to a
 * local corpus under ~/.flint/training. Frontier (Claude) answers are the
 * distillation targets — the teacher; local answers are the current student.
 * Fine-tuning an owned open model on this corpus is how Flint's own model
 * absorbs capability over time and walks toward independence. The data is
 * yours, on your machine, never sent anywhere.
 */
export class TrainingLogger {
  private seq = 0;
  private frontier = 0;
  private local = 0;

  constructor(private readonly path: string) {
    this.bootstrapCount();
  }

  log(rec: Omit<TrainingRecord, 'ts' | 'id'>, ts: number): void {
    const input = (rec.input ?? '').trim();
    const output = (rec.output ?? '').trim();
    if (!input || !output) return; // only keep complete pairs
    const full: TrainingRecord = { ts, id: ++this.seq, ...rec, input, output };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8');
      if (rec.brain === 'frontier') this.frontier++;
      else this.local++;
    } catch (err) {
      console.error('[training] failed to append record:', err);
    }
  }

  stats(): { total: number; teacher: number; student: number; path: string } {
    return { total: this.frontier + this.local, teacher: this.frontier, student: this.local, path: this.path };
  }

  /** Count existing records on boot so the corpus survives restarts. */
  private bootstrapCount(): void {
    try {
      if (!existsSync(this.path)) return;
      let maxId = 0;
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t) as TrainingRecord;
          if (typeof r.id === 'number' && r.id > maxId) maxId = r.id;
          if (r.brain === 'frontier') this.frontier++;
          else this.local++;
        } catch {
          /* skip malformed line */
        }
      }
      this.seq = maxId;
      console.error(`[training] corpus has ${this.frontier + this.local} examples (${this.frontier} teacher / ${this.local} student)`);
    } catch (err) {
      console.error('[training] failed to read corpus:', err);
    }
  }
}
