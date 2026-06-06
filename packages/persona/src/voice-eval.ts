import { FLINT_BANNED_PHRASES } from './flint.js';

export interface VoiceViolation {
  rule: string;
  detail: string;
}

export interface VoiceScore {
  /** 1 = clean, lower = more violations. */
  score: number;
  passed: boolean;
  violations: VoiceViolation[];
}

export interface VoiceCheckOptions {
  /** Override the banned-phrase list. Defaults to FLINT_BANNED_PHRASES. */
  bannedPhrases?: string[];
}

/**
 * Score a model's output against Flint's hard voice rules. Deliberately
 * conservative: it catches the unambiguous tells (banned phrases, opening by
 * restating the question, empty hedging). It does NOT try to judge taste —
 * that's for held-out human eval (see docs/PHASE3.md). This is the cheap,
 * automatable first gate, and it's the same gate for local and cloud models.
 */
export function checkVoice(text: string, opts: VoiceCheckOptions = {}): VoiceScore {
  const banned = opts.bannedPhrases ?? FLINT_BANNED_PHRASES;
  const violations: VoiceViolation[] = [];
  const lower = text.toLowerCase();

  for (const phrase of banned) {
    if (lower.includes(phrase.toLowerCase())) {
      violations.push({ rule: 'banned-phrase', detail: phrase });
    }
  }

  const firstSentence = (text.trim().split(/(?<=[.!?])\s/)[0] ?? '').trim();

  // Opening by asking a question = not answering first.
  if (firstSentence.endsWith('?')) {
    violations.push({
      rule: 'answer-first',
      detail: 'Opens with a question instead of the answer.',
    });
  }

  // Reflexive both-sidesing that resolves to "it depends".
  if (/\bit depends\b/i.test(text) && !/it depends on whether|it depends on the/i.test(text)) {
    violations.push({
      rule: 'no-both-sidesing',
      detail: '"it depends" without committing to a condition.',
    });
  }

  // "it's not X, it's Y" construction.
  if (/it'?s not .{1,40}?,?\s+it'?s\b/i.test(text)) {
    violations.push({ rule: 'no-not-x-its-y', detail: '"it\'s not X, it\'s Y" construction.' });
  }

  const passed = violations.length === 0;
  const score = Math.max(0, 1 - violations.length * 0.25);
  return { score, passed, violations };
}
