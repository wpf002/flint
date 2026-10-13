import { describe, it, expect } from 'vitest';
import {
  APPLE_USABLE_FRACTION,
  EMBEDDING_MODEL,
  EmbeddingModelSchema,
  HARDWARE_TIERS,
  HARDWARE_TIER_IDS,
  HardwareTierSchema,
  TIER_TOLERANCE,
  derivedModelName,
  hardwareTier,
  hardwareTierFor,
  hardwareTiersMarkdown,
  isTopTier,
  modelDisplayName,
  modelDownloadGb,
  tierFilesGb,
  tierFloorGb,
  usableMemoryGb,
  type HardwareTier,
} from '../../src/hardware-tiers.js';
import { DEFAULT_OLLAMA_MODEL, isOllamaCloudModel } from '../../src/provider/ollama/default-model.js';

/**
 * The hardware tier table: the one place a local model tag is named, and how a
 * machine's memory maps onto it.
 */

const gpuRows = HARDWARE_TIERS.filter((t) => t.minSystemGb === undefined);
const cpuRows = HARDWARE_TIERS.filter((t) => t.minSystemGb !== undefined);
/** VRAM as nvidia-smi reports it (MiB), the way the server reads it: GiB to one decimal. */
const mib = (n: number): number => Math.round((n / 1024) * 10) / 10;

describe('HARDWARE_TIERS: the table', () => {
  it('has the six tiers, in order, each exactly once: the CPU rows, then the GPU rows', () => {
    expect(HARDWARE_TIERS.map((t) => t.id)).toEqual(['cpu-small', 'cpu', '8gb', '16gb', '24gb', '48gb']);
    expect(HARDWARE_TIERS.map((t) => t.id)).toEqual([...HARDWARE_TIER_IDS]);
    expect(HARDWARE_TIERS.map((t) => t.label)).toEqual(['CPU, Low Memory', 'CPU Only', '8 GB', '16 GB', '24 GB', '48 GB+']);
    expect(cpuRows.map((t) => t.id)).toEqual(['cpu-small', 'cpu']);
  });

  it('every row passes the schema, with no field the schema does not know', () => {
    for (const row of HARDWARE_TIERS) expect(() => HardwareTierSchema.parse(row), row.id).not.toThrow();
    expect(() => HardwareTierSchema.parse({ ...HARDWARE_TIERS[1], extra: 1 })).toThrow();
    expect(() => HardwareTierSchema.parse({ ...HARDWARE_TIERS[1], model: 'not a tag; rm -rf' })).toThrow();
    expect(() => HardwareTierSchema.parse({ ...HARDWARE_TIERS[1], name: '<b>Llama</b>' })).toThrow();
    expect(() => HardwareTierSchema.parse({ ...HARDWARE_TIERS[1], name: 'llama3.2:3b' })).toThrow();
  });

  it('a standby is a model, a name, a context and a size together, or nothing', () => {
    const { fallbackName: _n, ...noName } = hardwareTier('cpu');
    expect(() => HardwareTierSchema.parse(noName)).toThrow();
    const { fallbackContextLength: _c, ...noContext } = hardwareTier('16gb');
    expect(() => HardwareTierSchema.parse(noContext)).toThrow();
    // Two rows have none: their smallest machine has no room for a second model (the fit test below).
    expect(HARDWARE_TIERS.filter((t) => t.fallbackModel === undefined).map((t) => t.id)).toEqual(['cpu-small', '8gb']);
    for (const row of HARDWARE_TIERS.filter((t) => t.fallbackModel === undefined)) {
      expect([row.fallbackName, row.fallbackContextLength, row.fallbackDownloadGb], row.id).toEqual([undefined, undefined, undefined]);
    }
  });

  it('a CPU row has no accelerator memory; a GPU row has no RAM threshold', () => {
    expect(() => HardwareTierSchema.parse({ ...hardwareTier('cpu'), minGb: 8 })).toThrow();
    for (const row of cpuRows) expect(row.minGb, row.id).toBe(0);
    for (const row of gpuRows) expect(row.minSystemGb, row.id).toBeUndefined();
  });

  it('every model and standby is a plain Ollama tag that runs on this machine (never a cloud model)', () => {
    for (const row of HARDWARE_TIERS) {
      for (const m of [row.model, row.fallbackModel].filter((x): x is string => x !== undefined)) {
        expect(m, row.id).toMatch(/^[a-z0-9._-]+:[a-z0-9._-]+$/);
        expect(isOllamaCloudModel(m), m).toBe(false);
      }
    }
  });

  it("a standby is never its own row's model, and is smaller than it", () => {
    for (const row of HARDWARE_TIERS.filter((t) => t.fallbackModel)) {
      expect(row.fallbackModel, row.id).not.toBe(row.model);
      expect(row.fallbackDownloadGb!, row.id).toBeLessThan(row.downloadGb);
      // "A ~1-2 GB model": the standby answers while the main one loads, so it must load fast.
      expect(row.fallbackDownloadGb!, row.id).toBeLessThanOrEqual(2.5);
    }
  });

  it('memory thresholds rise with the tiers, and the lowest GPU row does not take a 2 to 4 GB card', () => {
    const mins = gpuRows.map((t) => t.minGb);
    expect(mins).toEqual([6, 16, 24, 48]);
    expect(cpuRows.map((t) => t.minSystemGb)).toEqual([0, 8]);
  });

  it('a bigger tier never recommends a smaller download or a smaller context', () => {
    for (const rows of [gpuRows, cpuRows]) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.downloadGb, rows[i]!.id).toBeGreaterThanOrEqual(rows[i - 1]!.downloadGb);
        expect(rows[i]!.contextLength, rows[i]!.id).toBeGreaterThanOrEqual(rows[i - 1]!.contextLength);
      }
    }
  });

  // The final review's M6. The server loads a row's model and its standby together in the local and hybrid modes,
  // with the embedding model beside them. The 8 GB row is given to a machine with 6 GB a model can use (an 8 GB
  // Mac, a 6 GB card) and listed 4.7 + 1.3 GB, which with the embedding model is 6.3. The old check here left the
  // embedding model and the tolerance out, and passed at exactly 6.0.
  it("every row's own files fit the SMALLEST machine the row is given to: its model, its standby and the embedding model", () => {
    for (const row of gpuRows) {
      const files = tierFilesGb(row);
      const floor = tierFloorGb(row);
      expect(files, `${row.id}: ${files} GB of files in ${floor} GB`).toBeLessThanOrEqual(floor);
      // ...and the floor really is a machine hardwareTierFor gives this row to, with nothing smaller reaching it.
      expect(hardwareTierFor({ accelerator: 'nvidia', memoryGb: floor }).id, row.id).toBe(row.id);
      expect(hardwareTierFor({ accelerator: 'nvidia', memoryGb: floor - 0.1 }).id, row.id).not.toBe(row.id);
    }
    // A CPU row shares its machine's RAM with everything else running on it: half of it, at most.
    for (const row of cpuRows.filter((t) => t.minSystemGb! > 0)) {
      expect(tierFilesGb(row), row.id).toBeLessThanOrEqual(tierFloorGb(row) / 2);
      expect(hardwareTierFor({ accelerator: 'none', memoryGb: 0, systemMemoryGb: tierFloorGb(row) }).id).toBe(row.id);
    }
    // The row of last resort takes every machine nothing else fits, so it asks the least of any row, and no standby.
    const last = cpuRows.find((t) => t.minSystemGb === 0)!;
    expect(tierFloorGb(last)).toBe(0);
    expect(last.fallbackModel).toBeUndefined();
    expect(tierFilesGb(last)).toBe(Math.min(...HARDWARE_TIERS.map((t) => tierFilesGb(t))));
  });

  it('the numbers, row by row, so a change to a row is seen against its floor', () => {
    expect(HARDWARE_TIERS.map((t) => [t.id, tierFilesGb(t), tierFloorGb(t)])).toEqual([
      ['cpu-small', 1.6, 0],
      ['cpu', 3.6, 7.44],
      ['8gb', 5, 5.58],
      ['16gb', 11.3, 14.88],
      ['24gb', 11.6, 22.32],
      ['48gb', 20.5, 44.64],
    ]);
    // What the 8 GB row was: 6.3 GB of files for a machine with 5.58 to 6 GB to give.
    expect(tierFilesGb({ downloadGb: 4.7, fallbackDownloadGb: 1.3 })).toBe(6.3);
    expect(tierFilesGb({ downloadGb: 4.7, fallbackDownloadGb: 1.3 })).toBeGreaterThan(usableMemoryGb({ accelerator: 'apple-silicon', memoryGb: 8 }));
  });

  it('only a row Flint has measured says so', () => {
    expect(HARDWARE_TIERS.filter((t) => t.measured).map((t) => t.id)).toEqual(['48gb']);
  });
});

describe('display names: what the console shows in place of a tag', () => {
  it('every row has one for its model and its standby, in Title Case, and it is never the tag', () => {
    for (const row of HARDWARE_TIERS) {
      for (const [m, name] of [[row.model, row.name], [row.fallbackModel, row.fallbackName]] as const) {
        if (m === undefined) continue;
        expect(name, row.id).toMatch(/^[A-Z][A-Za-z0-9]*( [A-Z0-9][A-Za-z0-9.]*)+$/);
        expect(name, row.id).not.toContain(':');
        expect(name).not.toBe(m);
      }
    }
    expect(hardwareTier('48gb').name).toBe('Muse Glimmer 30B');
    expect(hardwareTier('8gb').name).toBe('Qwen 2.5 7B');
    expect(hardwareTier('cpu').name).toBe('Llama 3.2 3B');
  });

  it('one tag has one name wherever it appears in the table', () => {
    const seen = new Map<string, string>();
    for (const row of HARDWARE_TIERS) {
      for (const [m, name] of [[row.model, row.name], [row.fallbackModel, row.fallbackName]] as const) {
        if (m === undefined || name === undefined) continue;
        expect(seen.get(m) ?? name, m).toBe(name);
        seen.set(m, name);
      }
    }
  });

  it('modelDisplayName: the table for a model it lists, with or without :latest, in any case', () => {
    expect(modelDisplayName('muse-glimmer:30b')).toBe('Muse Glimmer 30B');
    expect(modelDisplayName('Llama3.2:1B')).toBe('Llama 3.2 1B');
    expect(modelDisplayName('nomic-embed-text')).toBe('Nomic Embed Text');
    expect(modelDisplayName('nomic-embed-text:latest')).toBe('Nomic Embed Text');
    // The table's own names are what the derivation would say: a new row needs no surprise.
    for (const row of HARDWARE_TIERS) expect(derivedModelName(row.model), row.model).toBe(row.name);
  });

  it('a model the table does not list gets a readable name made from its tag, never the raw tag', () => {
    const cases: Array<[string, string]> = [
      ['qwen3.6:35b', 'Qwen 3.6 35B'],
      ['gemma4:26b', 'Gemma 4 26B'],
      ['qwen2.5-coder:1.5b', 'Qwen 2.5 Coder 1.5B'],
      ['deepseek-r1:8b', 'Deepseek R1 8B'],
      ['phi4-mini', 'Phi 4 Mini'],
      ['mistral:latest', 'Mistral'],
      ['mxbai-embed-large:latest', 'Mxbai Embed Large'],
      ['llama3.1:8b-instruct-q4_K_M', 'Llama 3.1 8B Instruct Q4-K-M'],
      ['hf.co/org/cloudy-repo:Q4_K_M', 'Cloudy Repo Q4-K-M'],
      // The final review's C9, the three names it showed on screen: "GEMMA3N E4B", "QWEN2.5VL", "Qwen Qwen 3 30B A3B Gguf Q4 K M".
      ['gemma3n:e4b', 'Gemma 3n E4B'],
      ['qwen2.5vl', 'Qwen 2.5 VL'],
      ['qwen2.5vl:7b', 'Qwen 2.5 VL 7B'],
      ['hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:Q4_K_M', 'Qwen 3 30B A3B Q4-K-M'],
      ['hf.co/unsloth/gemma-3n-E4B-it-GGUF:Q8_0', 'Gemma 3N E4B It Q8-0'],
      // A word that only happens to begin another is kept when it is not followed by it.
      ['qwen-coder:qwen', 'Qwen Coder Qwen'],
      ['llama-llamafile', 'Llamafile'],
      ['/models/Meta-Llama-3.1-8B-Instruct.gguf', 'Meta Llama 3.1 8B Instruct'],
      ['gpt-oss-20b', 'Gpt Oss 20B'],
    ];
    for (const [tag, name] of cases) {
      expect(modelDisplayName(tag), tag).toBe(name);
      expect(name).not.toContain(':');
    }
  });

  it('whatever it is given, only letters, digits, spaces and . + - come out, 40 characters at most', () => {
    for (const bad of ['<script>alert(1)</script>', 'a"b\'c`d:e;f', '../../etc/passwd', '   ', '', ':', '::::', 'x'.repeat(300), '$(reboot):7b', 'm\u0000odel:1b', '-rf:latest']) {
      const name = derivedModelName(bad);
      expect(name, JSON.stringify(bad)).toMatch(/^[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}$/);
    }
    expect(derivedModelName('')).toBe('Local Model');
    expect(derivedModelName(':')).toBe('Local Model');
  });
});

describe('the embedding model is in the table file too', () => {
  it('is a plain tag with a name and a size, and passes its schema', () => {
    expect(() => EmbeddingModelSchema.parse(EMBEDDING_MODEL)).not.toThrow();
    expect(EMBEDDING_MODEL).toEqual({ model: 'nomic-embed-text', name: 'Nomic Embed Text', downloadGb: 0.3 });
    expect(Object.isFrozen(EMBEDDING_MODEL)).toBe(true);
    expect(isOllamaCloudModel(EMBEDDING_MODEL.model)).toBe(false);
  });

  it('modelDownloadGb knows every size the table lists, and nothing else', () => {
    expect(modelDownloadGb('muse-glimmer:30b')).toBe(18.2);
    expect(modelDownloadGb('llama3.2:1b')).toBe(1.3);
    expect(modelDownloadGb('nomic-embed-text:latest')).toBe(0.3);
    expect(modelDownloadGb('qwen3.6:35b')).toBeUndefined();
  });
});

describe('usableMemoryGb: what a model can take', () => {
  it("an NVIDIA GPU's VRAM is all the model's", () => {
    expect(usableMemoryGb({ accelerator: 'nvidia', memoryGb: 24 })).toBe(24);
  });

  it("three quarters of an Apple Silicon Mac's unified memory: the rest is the system's", () => {
    expect(APPLE_USABLE_FRACTION).toBe(0.75);
    expect(usableMemoryGb({ accelerator: 'apple-silicon', memoryGb: 64 })).toBe(48);
    expect(usableMemoryGb({ accelerator: 'apple-silicon', memoryGb: 32 })).toBe(24);
    expect(usableMemoryGb({ accelerator: 'apple-silicon', memoryGb: 16 })).toBe(12);
    expect(usableMemoryGb({ accelerator: 'apple-silicon', memoryGb: 8 })).toBe(6);
  });

  it('nothing with no accelerator, or with memory that makes no sense', () => {
    expect(usableMemoryGb({ accelerator: 'none', memoryGb: 64 })).toBe(0);
    for (const bad of [NaN, Infinity, -4, 0]) expect(usableMemoryGb({ accelerator: 'nvidia', memoryGb: bad })).toBe(0);
  });
});

describe('hardwareTierFor: usable memory rounds DOWN to a tier', () => {
  const tierOf = (accelerator: 'apple-silicon' | 'nvidia' | 'none', memoryGb: number, systemMemoryGb?: number) =>
    hardwareTierFor({ accelerator, memoryGb, ...(systemMemoryGb !== undefined ? { systemMemoryGb } : {}) }).id;

  it('Apple Silicon, by the Macs that are sold', () => {
    expect(tierOf('apple-silicon', 8)).toBe('8gb');
    expect(tierOf('apple-silicon', 16)).toBe('8gb');
    expect(tierOf('apple-silicon', 18)).toBe('8gb');
    expect(tierOf('apple-silicon', 24)).toBe('16gb');
    expect(tierOf('apple-silicon', 32)).toBe('24gb');
    expect(tierOf('apple-silicon', 36)).toBe('24gb');
    expect(tierOf('apple-silicon', 48)).toBe('24gb');
    // Will's Mac: 64 GB gives 48 usable, the top tier.
    expect(tierOf('apple-silicon', 64)).toBe('48gb');
    expect(tierOf('apple-silicon', 96)).toBe('48gb');
    expect(tierOf('apple-silicon', 512)).toBe('48gb');
  });

  it('NVIDIA cards sold at a tier size report a little less, and still land in their tier', () => {
    expect(TIER_TOLERANCE).toBe(0.07);
    // Tesla T4: 15,360 MiB.
    expect(tierOf('nvidia', mib(15360))).toBe('16gb');
    // A10G and L4: about 23,030 MiB. RTX 4090: 24,564.
    expect(tierOf('nvidia', mib(23028))).toBe('24gb');
    expect(tierOf('nvidia', mib(23034))).toBe('24gb');
    expect(tierOf('nvidia', mib(24564))).toBe('24gb');
    // A40: 46,068 MiB. RTX A6000: 49,140.
    expect(tierOf('nvidia', mib(46068))).toBe('48gb');
    expect(tierOf('nvidia', mib(49140))).toBe('48gb');
    // 16 GB cards: 16,376 MiB.
    expect(tierOf('nvidia', mib(16376))).toBe('16gb');
  });

  it('the tolerance is a little, not a tier: a 12 GB card is not 16, a 20 GB card is not 24, a 40 GB card is not 48', () => {
    expect(tierOf('nvidia', mib(12288))).toBe('8gb');
    expect(tierOf('nvidia', mib(11264))).toBe('8gb');
    expect(tierOf('nvidia', mib(20480))).toBe('16gb');
    expect(tierOf('nvidia', mib(40960))).toBe('24gb');
    expect(tierOf('nvidia', 14.8)).toBe('8gb');
    expect(tierOf('nvidia', 14.9)).toBe('16gb');
    expect(tierOf('nvidia', 22.3)).toBe('16gb');
    expect(tierOf('nvidia', 44.6)).toBe('24gb');
    expect(tierOf('nvidia', 44.7)).toBe('48gb');
  });

  it('small cards: 6 and 8 GB are the 8 GB tier; 2 to 4 GB fall to the CPU rows', () => {
    expect(tierOf('nvidia', mib(8192), 16)).toBe('8gb');
    expect(tierOf('nvidia', mib(6144), 16)).toBe('8gb');
    expect(tierOf('nvidia', mib(4096), 16)).toBe('cpu');
    expect(tierOf('nvidia', mib(2048), 16)).toBe('cpu');
    expect(tierOf('nvidia', mib(4096), 4)).toBe('cpu-small');
  });

  it('no accelerator: the CPU row its RAM reaches', () => {
    expect(tierOf('none', 0, 128)).toBe('cpu');
    expect(tierOf('none', 0, 16)).toBe('cpu');
    // A machine sold with 8 GB reports a little under it.
    expect(tierOf('none', 0, 7.7)).toBe('cpu');
    expect(tierOf('none', 0, 7.4)).toBe('cpu-small');
    expect(tierOf('none', 0, 4)).toBe('cpu-small');
    expect(tierOf('none', 0, 2)).toBe('cpu-small');
  });

  // The final review's L9: this said "the smallest thing to ask of a machine" and picked the larger CPU row,
  // with its two models, for a machine whose RAM nobody knew.
  it('RAM that is not known is the smallest row: the least to ask of a machine nothing is known about', () => {
    expect(tierOf('none', 0)).toBe('cpu-small');
    expect(tierOf('none', 0, NaN)).toBe('cpu-small');
    expect(tierOf('none', 0, 0)).toBe('cpu-small');
    expect(tierOf('none', 0, -16)).toBe('cpu-small');
    expect(tierOf('none', 0, Infinity)).toBe('cpu-small');
    // The smallest row asks for one model and no standby (the fit test above).
    expect(hardwareTier('cpu-small').fallbackModel).toBeUndefined();
  });

  it('accelerator memory that makes no sense is no accelerator: a CPU row, by the RAM that is known', () => {
    expect(tierOf('nvidia', NaN, 64)).toBe('cpu');
    expect(tierOf('apple-silicon', Infinity, 64)).toBe('cpu');
    expect(tierOf('nvidia', -8, 4)).toBe('cpu-small');
    // ...and with the RAM unknown too, the smallest.
    expect(tierOf('nvidia', NaN)).toBe('cpu-small');
  });

  it('works on an edited table: the rows are the policy', () => {
    const edited: HardwareTier[] = HARDWARE_TIERS.map((t) => (t.id === '48gb' ? { ...t, minGb: 96 } : t));
    expect(hardwareTierFor({ accelerator: 'apple-silicon', memoryGb: 64 }, edited).id).toBe('24gb');
    const oneCpu: HardwareTier[] = HARDWARE_TIERS.filter((t) => t.id !== 'cpu-small');
    expect(hardwareTierFor({ accelerator: 'none', memoryGb: 0, systemMemoryGb: 2 }, oneCpu).id).toBe('cpu');
  });
});

describe('hardwareTier / isTopTier', () => {
  it('finds a row by id', () => {
    expect(hardwareTier('16gb').minGb).toBe(16);
  });

  it('the top tier is the last row', () => {
    expect(HARDWARE_TIERS.filter((t) => isTopTier(t)).map((t) => t.id)).toEqual(['48gb']);
  });
});

describe('the default Ollama model reads the table', () => {
  it("is the 8 GB tier's model, the same tag as before", () => {
    expect(DEFAULT_OLLAMA_MODEL).toBe(hardwareTier('8gb').model);
    expect(DEFAULT_OLLAMA_MODEL).toBe('qwen2.5:7b');
  });
});

describe('hardwareTiersMarkdown', () => {
  const rows = hardwareTiersMarkdown().split('\n').slice(2);

  it('has one row per tier, with each model and its name, and says which rows are unmeasured', () => {
    expect(rows).toHaveLength(HARDWARE_TIERS.length);
    rows.forEach((row, i) => {
      const t = HARDWARE_TIERS[i]!;
      expect(row).toContain(`| ${t.label} |`);
      expect(row).toContain(`\`${t.model}\` (${t.name})`);
      expect(row).toContain(t.fallbackModel ? `\`${t.fallbackModel}\` (${t.fallbackName})` : '| none | none |');
      expect(row).toContain(t.measured ? '| yes |' : '| recommended, unmeasured |');
    });
    expect(rows[5]).toContain('| 16,384 |');
    expect(rows[0]).toContain('| 1.3 GB |');
    expect(rows[2]).toContain('| none | none | 4.7 GB |');
    expect(rows[3]).toContain('| 9.0 GB + 2.0 GB |');
  });

  it('what a row says of its machine comes from the next row, not from a number written twice', () => {
    expect(rows.map((r) => r.split('|')[2]!.trim())).toEqual([
      'no usable GPU, under 8 GB of RAM',
      'no usable GPU, 8 GB of RAM or more',
      '6 GB to under 16 GB of usable memory',
      '16 GB to under 24 GB of usable memory',
      '24 GB to under 48 GB of usable memory',
      '48 GB of usable memory or more',
    ]);
    const edited: HardwareTier[] = HARDWARE_TIERS.map((t) => (t.id === '16gb' ? { ...t, minGb: 12 } : t.id === 'cpu' ? { ...t, minSystemGb: 12 } : t));
    const machines = hardwareTiersMarkdown(edited).split('\n').slice(2).map((r) => r.split('|')[2]!.trim());
    expect(machines[0]).toBe('no usable GPU, under 12 GB of RAM');
    expect(machines[1]).toBe('no usable GPU, 12 GB of RAM or more');
    expect(machines[2]).toBe('6 GB to under 12 GB of usable memory');
    expect(machines[3]).toBe('12 GB to under 24 GB of usable memory');
  });
});
