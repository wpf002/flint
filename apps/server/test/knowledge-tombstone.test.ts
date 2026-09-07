import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../src/knowledge';

// The embedder is only used for vectors; recall isn't under test here.
const stubEmbedder = {
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
} as unknown as ConstructorParameters<typeof KnowledgeStore>[1];

describe('KnowledgeStore tombstones', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-know-'));
    path = join(dir, 'knowledge.json');
  });

  const store = () => new KnowledgeStore(path, stubEmbedder);

  it('stores and recalls a normal fact', async () => {
    const s = store();
    expect(await s.add('Will lives in Dallas, Texas.')).toBe(true);
    expect(s.size).toBe(1);
  });

  /*
   * The regression this exists for: the automatic extractor re-derived
   * "Will's favorite baseball team is the Houston Astros" — a fabrication Will
   * had already rejected — out of an old transcript. Deleting a wrong fact has
   * to make it STAY deleted, or every extraction pass resurrects it.
   */
  it('a forgotten fact cannot be re-added', async () => {
    const s = store();
    await s.add("Will's favorite baseball team is the Houston Astros.");
    const id = s.all()[0]!.id;
    expect(s.forget(id)).toBe(true);
    expect(s.size).toBe(0);

    expect(await s.add("Will's favorite baseball team is the Houston Astros.")).toBe(false);
    expect(s.size).toBe(0);
  });

  it('the bar ignores case, punctuation and spacing', async () => {
    const s = store();
    s.reject("Will's favorite baseball team is the Houston Astros.");
    for (const variant of [
      "will's favorite baseball team is the houston astros",
      'Wills favorite baseball team is the Houston Astros!!',
      "Will's   favorite baseball team is the Houston Astros.",
    ]) {
      expect(await s.add(variant, 'history')).toBe(false);
    }
    expect(s.size).toBe(0);
  });

  it('reject() removes an already-stored fact', async () => {
    const s = store();
    await s.add('A wrong thing.');
    s.reject('A wrong thing.');
    expect(s.size).toBe(0);
    expect(s.rejectedTexts()).toHaveLength(1);
  });

  it('tombstones survive a reload from disk', async () => {
    const s1 = store();
    await s1.add('Bogus fact about Will.');
    s1.forget(s1.all()[0]!.id);

    const s2 = store(); // fresh instance, same file
    expect(await s2.add('Bogus fact about Will.', 'history')).toBe(false);
    expect(s2.size).toBe(0);
  });

  it('does not bar unrelated facts', async () => {
    const s = store();
    s.reject('Wrong thing.');
    expect(await s.add('Will bought a Mac Studio M4 Max.')).toBe(true);
    expect(s.size).toBe(1);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});
