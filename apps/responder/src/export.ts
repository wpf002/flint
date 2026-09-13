import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Participant } from './participant.js';
import type { BuiltArtifact } from './prompt.js';
import { materialise } from './workspace.js';

/*
 * A thread's product, written out as an ordinary project.
 *
 * Read from Nexus, not from a workspace on disk. The workspace is a cache on whichever
 * machine runs the responder, and once the responder moved to Railway, exporting from
 * the laptop found nothing for any new thread. Nexus holds every artifact, nested paths
 * included, plus the files a build produced (lockfiles, generated code), so it's the one
 * place a complete copy always exists.
 */

export interface ExportResult {
  files: number;
  destination: string;
  /** Names that would have landed outside the destination, and were not written. */
  refused: string[];
}

export async function exportThread(
  participant: Participant,
  threadId: string,
  destination: string,
): Promise<ExportResult> {
  const dest = resolve(destination);
  // An export into a directory that already has files in it would overwrite them without
  // saying so. Refused up front, before anything is read or written.
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new Error(`${dest} is not empty. Export into a new directory.`);
  }

  const listing = await participant.call<{ artifacts?: Array<{ name: string }> }>('artifact_read', { threadId });
  const names = (listing.artifacts ?? []).map((a) => a.name);
  if (names.length === 0) throw new Error(`Thread ${threadId} has built nothing to export.`);

  mkdirSync(dest, { recursive: true });
  const refused: string[] = [];
  let files = 0;
  for (const name of names) {
    const artifact = await participant.call<BuiltArtifact>('artifact_read', { threadId, name });
    try {
      materialise(dest, artifact.name, artifact.content);
      files += 1;
    } catch {
      refused.push(artifact.name);
    }
  }
  return { files, destination: dest, refused };
}
