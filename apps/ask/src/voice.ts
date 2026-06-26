import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

/**
 * Voice I/O (Phase 4) — all local, no cloud.
 *   TTS  : macOS `say` (built-in)
 *   STT  : whisper.cpp (`whisper-cli`) on a 16 kHz mono WAV
 *   record: `sox -d` with silence auto-stop (push-to-talk by speaking)
 *   convert: `afconvert` (built-in) for non-WAV inputs
 *
 * Each piece is swappable via env (WHISPER_BIN, WHISPER_MODEL, FLINT_VOICE).
 */

const DATA_DIR = join(homedir(), '.flint');

export function defaultModelPath(): string {
  return process.env.WHISPER_MODEL ?? join(DATA_DIR, 'models', 'ggml-base.en.bin');
}

/** Speak text aloud via macOS `say`. */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  const args: string[] = [];
  const voice = process.env.FLINT_VOICE;
  if (voice) args.push('-v', voice);
  args.push(text);
  await exec('say', args);
}

/** Convert any audio file to 16 kHz mono WAV (what whisper.cpp wants). */
export async function toWav16k(input: string, output: string): Promise<void> {
  await exec('afconvert', [input, output, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
}

/** Transcribe a 16 kHz mono WAV with whisper.cpp. Returns the text. */
export async function transcribe(wavPath: string): Promise<string> {
  const binary = process.env.WHISPER_BIN ?? 'whisper-cli';
  const model = defaultModelPath();
  if (!existsSync(model)) {
    throw new Error(`Whisper model not found at ${model}. Set WHISPER_MODEL or run the voice setup.`);
  }
  // -nt: no timestamps · -np: no progress/prints · output goes to stdout.
  const { stdout } = await exec(binary, ['-m', model, '-f', wavPath, '-nt', '-np'], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout.replace(/\s+/g, ' ').trim();
}

/**
 * Record from the mic until ~1.5s of silence, to a 16 kHz mono WAV.
 * Requires `sox`. Returns the path (or throws if sox is missing).
 */
export async function recordUtterance(out: string, maxSeconds = 30): Promise<string> {
  // sox -d (default input) → wav; silence: start on sound, stop after 1.5s quiet.
  await exec('sox', [
    '-q', '-d', '-r', '16000', '-c', '1', '-b', '16', out,
    'silence', '1', '0.1', '2%', '1', '1.5', '2%',
    'trim', '0', String(maxSeconds),
  ]);
  return out;
}

/** Speak text that says aloud + return it (for a spoken Flint reply). */
export async function say(text: string): Promise<void> {
  await speak(text);
}
