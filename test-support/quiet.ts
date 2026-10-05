/**
 * Tests never reach Will's screen. On 2026-10-05 a test ran a copied system
 * binary from a fake Flint.app, and macOS told Will that "Flint" was damaged.
 * Every vitest run in the repo loads this first (each vitest.config.ts lists it
 * in setupFiles; apps/server/test/tests-stay-quiet.test.ts checks that): it puts
 * no-op stand-ins for the commands that show, say or open things (notifications
 * and dialogs, opening apps, speech, sound) first on PATH, for the tests and for
 * every script they spawn.
 */
import { join } from 'node:path';

const bin = join(__dirname, 'quiet-bin');
if (!(process.env.PATH ?? '').split(':').includes(bin)) process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
