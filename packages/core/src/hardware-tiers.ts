import { z } from 'zod';

/**
 * Hardware tiers: which local model a machine should run.
 *
 * THIS IS THE ONE PLACE A LOCAL MODEL IS NAMED: the chat models, the standby
 * models, and the embedding model (EMBEDDING_MODEL, below the table). To
 * recommend a different model for a class of machine, edit its row here;
 * nothing else in Flint hardcodes a local model (a test in the server checks
 * that).
 *
 * A machine is sorted into a tier by the memory a model can USE:
 *  - an NVIDIA GPU: its VRAM (the largest single card);
 *  - an Apple Silicon Mac: three quarters of its unified memory
 *    (APPLE_USABLE_FRACTION). The rest is the system's and the apps': a model
 *    that takes all of a Mac's memory pushes everything else into swap. So a
 *    64 GB Mac has 48 GB for a model, a 32 GB Mac 24, a 16 GB Mac 12;
 *  - neither, or a card too small for the smallest GPU row: the CPU rows,
 *    chosen by the machine's RAM.
 * A tier's number is reached at 93% of it (TIER_TOLERANCE): a card sold as
 * 16 GB reports 15,360 MiB, and one sold as 24 GB about 23,030.
 *
 * Each row names:
 *  - `model`: the recommended chat model, as an Ollama tag, the context length
 *    to run it at, and `name`, how the console shows it ("Qwen 2.5 7B"). The
 *    console never shows a tag; the tag is for the command line and the
 *    `ollama pull` line;
 *  - `fallbackModel`: a small model (1 to 2 GB) that can answer while the main
 *    one loads (the server's warm-start standby), its name and its context
 *    length. A row whose smallest machine has no room for a second model has
 *    none (the smallest CPU row, and the 8 GB row);
 *  - `tools`: whether the model can call tools, used only when the model server
 *    cannot say (Ollama can: its own report wins);
 *  - `measured`: whether Flint's own parity harness has run this row's model on
 *    this class of hardware. A row that is not measured is a recommendation
 *    from the model's published size and capabilities, nothing more.
 *
 * Flint never downloads a model. A row is a recommendation; the status command
 * prints the `ollama pull` line for one that is not installed.
 */

export const HARDWARE_TIER_IDS = ['cpu-small', 'cpu', '8gb', '16gb', '24gb', '48gb'] as const;
export type HardwareTierId = (typeof HARDWARE_TIER_IDS)[number];

/** What runs the model: Apple Silicon's unified memory, an NVIDIA GPU, or neither. */
export type Accelerator = 'apple-silicon' | 'nvidia' | 'none';

/** The share of an Apple Silicon Mac's unified memory a model may take. The rest is the system's and the apps'. */
export const APPLE_USABLE_FRACTION = 0.75;

/** A tier's memory number is reached at this much under it: hardware sold at a size reports a little less. */
export const TIER_TOLERANCE = 0.07;

/** An Ollama model tag: `name`, `name:tag`, `namespace/name:tag`. */
const tag = z.string().min(1).max(100).regex(/^[a-z0-9._:\-/]+$/i);

/** A model's name as the console shows it: words and numbers, nothing a screen could misread. */
const displayName = z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 .+-]*$/);

export const HardwareTierSchema = z
  .object({
    id: z.enum(HARDWARE_TIER_IDS),
    /** How the tier is shown: Title Case, short. */
    label: z.string().min(1).max(20),
    /** Smallest USABLE accelerator memory in GiB for this tier. 0 on a CPU row. */
    minGb: z.number().int().nonnegative(),
    /** CPU rows only, and what makes a row one: the smallest system RAM in GiB for it. */
    minSystemGb: z.number().int().nonnegative().optional(),
    model: tag,
    /** `model`, as the console shows it. */
    name: displayName,
    contextLength: z.number().int().positive(),
    /** Can `model` call tools? Used when the model server cannot say. */
    tools: z.boolean(),
    /** The standby, its name and its context: all three, or none (a row with no room for a second model). */
    fallbackModel: tag.optional(),
    fallbackName: displayName.optional(),
    fallbackContextLength: z.number().int().positive().optional(),
    /** Download sizes in GB, for the status text. */
    downloadGb: z.number().positive(),
    fallbackDownloadGb: z.number().positive().optional(),
    /** Has Flint's parity harness run `model` on this class of hardware? */
    measured: z.boolean(),
  })
  .strict()
  .refine((t) => new Set([t.fallbackModel, t.fallbackName, t.fallbackContextLength, t.fallbackDownloadGb].map((v) => v === undefined)).size === 1, {
    message: 'a standby is a model, a name, a context and a size together, or nothing',
  })
  .refine((t) => t.minSystemGb === undefined || t.minGb === 0, { message: 'a CPU row has no accelerator memory' });
export type HardwareTier = z.infer<typeof HardwareTierSchema>;

/**
 * The table. Ordered from the smallest machine to the largest: the CPU rows
 * (by system RAM), then the GPU and Apple Silicon rows (by usable memory).
 *
 * The lowest GPU row starts at 6 GB: a 2 to 4 GB card cannot hold its model,
 * and such a machine is a CPU row. The 16 GB row stays at a 4,096-token
 * context on purpose: above about 6,000 its model stops emitting tool calls.
 * Only the 48 GB+ row has been measured (it is the model Will's own bake-offs
 * kept, at the context it runs at).
 *
 * The standby's context (`fallbackContextLength`) is 8,192 where the machine
 * has the memory for a second model at that size (16 GB and up), and 4,096
 * below. The standby is given a compact guide and only the tools that fit, so
 * that its prompt fits its window: at 4,096 the default local guide alone
 * (about 3,980 tokens) left no room for the question.
 *
 * A machine with no usable GPU and under 8 GB of RAM gets the smallest model
 * alone: two models and the system do not fit in it.
 *
 * EVERY ROW'S OWN FILES FIT THE SMALLEST MACHINE THE ROW IS GIVEN TO
 * (`tierFilesGb` against `tierFloorGb`; a test checks every row). The server
 * loads a row's model and its standby together in the local and hybrid modes,
 * and the embedding model beside them. The 8 GB row begins at 6 GB of usable
 * memory (an 8 GB Mac, a 6 GB card, a little less within the tolerance), where
 * its model, a standby and the embedding model (6.3 GB) do not fit: so it has
 * no standby, and its model and the embedding model (5.0 GB) do.
 */
export const HARDWARE_TIERS: readonly HardwareTier[] = [
  { id: 'cpu-small', label: 'CPU, Low Memory', minGb: 0, minSystemGb: 0, model: 'llama3.2:1b', name: 'Llama 3.2 1B', contextLength: 4096, tools: false, downloadGb: 1.3, measured: false },
  { id: 'cpu', label: 'CPU Only', minGb: 0, minSystemGb: 8, model: 'llama3.2:3b', name: 'Llama 3.2 3B', contextLength: 4096, tools: true, fallbackModel: 'llama3.2:1b', fallbackName: 'Llama 3.2 1B', fallbackContextLength: 4096, downloadGb: 2.0, fallbackDownloadGb: 1.3, measured: false },
  { id: '8gb', label: '8 GB', minGb: 6, model: 'qwen2.5:7b', name: 'Qwen 2.5 7B', contextLength: 4096, tools: true, downloadGb: 4.7, measured: false },
  { id: '16gb', label: '16 GB', minGb: 16, model: 'qwen2.5:14b', name: 'Qwen 2.5 14B', contextLength: 4096, tools: true, fallbackModel: 'llama3.2:3b', fallbackName: 'Llama 3.2 3B', fallbackContextLength: 8192, downloadGb: 9.0, fallbackDownloadGb: 2.0, measured: false },
  { id: '24gb', label: '24 GB', minGb: 24, model: 'qwen3:14b', name: 'Qwen 3 14B', contextLength: 16384, tools: true, fallbackModel: 'llama3.2:3b', fallbackName: 'Llama 3.2 3B', fallbackContextLength: 8192, downloadGb: 9.3, fallbackDownloadGb: 2.0, measured: false },
  { id: '48gb', label: '48 GB+', minGb: 48, model: 'muse-glimmer:30b', name: 'Muse Glimmer 30B', contextLength: 16384, tools: true, fallbackModel: 'llama3.2:3b', fallbackName: 'Llama 3.2 3B', fallbackContextLength: 8192, downloadGb: 18.2, fallbackDownloadGb: 2.0, measured: true },
];

/**
 * The embedding model: what recall, the knowledge store and the tool router
 * turn text into vectors with (Ollama's /api/embeddings). It is the same on
 * every tier, so it is one entry and not a column. FLINT_EMBED_MODEL names
 * another.
 */
export const EmbeddingModelSchema = z.object({ model: tag, name: displayName, downloadGb: z.number().positive() }).strict();
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;
export const EMBEDDING_MODEL: EmbeddingModel = Object.freeze({ model: 'nomic-embed-text', name: 'Nomic Embed Text', downloadGb: 0.3 });

/**
 * What a row asks a machine to hold at once, in GB: its model, its standby
 * when it has one, and the embedding model. Sizes are the downloads, which is
 * what the weights take in memory (a context's working memory comes on top).
 */
export function tierFilesGb(t: Pick<HardwareTier, 'downloadGb' | 'fallbackDownloadGb'>, embedding: Pick<EmbeddingModel, 'downloadGb'> = EMBEDDING_MODEL): number {
  return Math.round((t.downloadGb + (t.fallbackDownloadGb ?? 0) + embedding.downloadGb) * 10) / 10;
}

/**
 * The least memory, in GB, of a machine this row is given to: a GPU row's
 * usable memory, a CPU row's RAM, each at the tolerance under its number
 * (hardwareTierFor's own rule). 0 for the row of last resort, which takes
 * every machine nothing else fits.
 */
export function tierFloorGb(t: Pick<HardwareTier, 'minGb' | 'minSystemGb'>): number {
  return Math.round((t.minSystemGb ?? t.minGb) * (1 - TIER_TOLERANCE) * 100) / 100;
}

/** A tier by its id. */
export function hardwareTier(id: HardwareTierId): HardwareTier {
  const row = HARDWARE_TIERS.find((t) => t.id === id);
  if (!row) throw new Error(`no hardware tier ${id}`);
  return row;
}

/** What a tier is chosen from. `systemMemoryGb` is the machine's RAM; it decides between the CPU rows. */
export interface TierMachine {
  accelerator: Accelerator;
  /** An NVIDIA GPU's VRAM, or an Apple Silicon Mac's unified memory, in GiB. */
  memoryGb: number;
  systemMemoryGb?: number;
}

/** The memory a model can use on this machine, in GiB: VRAM, or three quarters of unified memory. 0 with no accelerator. */
export function usableMemoryGb(h: Pick<TierMachine, 'accelerator' | 'memoryGb'>): number {
  if (!Number.isFinite(h.memoryGb) || h.memoryGb <= 0) return 0;
  if (h.accelerator === 'apple-silicon') return Math.round(h.memoryGb * APPLE_USABLE_FRACTION * 10) / 10;
  return h.accelerator === 'nvidia' ? h.memoryGb : 0;
}

const isCpuRow = (t: HardwareTier): t is HardwareTier & { minSystemGb: number } => t.minSystemGb !== undefined;
const reaches = (have: number, min: number): boolean => have >= min * (1 - TIER_TOLERANCE);

/**
 * The tier for a machine. The largest GPU row whose `minGb` its usable memory
 * reaches: memory rounds DOWN to a tier, so 45 GB of usable memory is the
 * 48 GB tier (within the tolerance) and 40 GB is the 24 GB tier, never asked to
 * hold a 48 GB model. A machine no GPU row fits (no accelerator, a 4 GB card)
 * is the largest CPU row its RAM reaches. RAM that is not known reaches only
 * the row of last resort (the one that starts at 0): the least to ask of a
 * machine nothing is known about. It used to get the largest CPU row.
 */
export function hardwareTierFor(h: TierMachine, tiers: readonly HardwareTier[] = HARDWARE_TIERS): HardwareTier {
  const usable = usableMemoryGb(h);
  let best: HardwareTier | undefined;
  if (usable > 0) {
    for (const t of tiers) {
      if (isCpuRow(t) || !reaches(usable, t.minGb)) continue;
      if (!best || t.minGb >= best.minGb) best = t;
    }
  }
  if (best) return best;
  const ram = h.systemMemoryGb;
  // RAM that is not known counts as none: only a row that asks for none is reached.
  const have = ram !== undefined && Number.isFinite(ram) && ram > 0 ? ram : 0;
  let cpu: (HardwareTier & { minSystemGb: number }) | undefined;
  for (const t of tiers) {
    if (!isCpuRow(t) || !reaches(have, t.minSystemGb)) continue;
    if (!cpu || t.minSystemGb >= cpu.minSystemGb) cpu = t;
  }
  return cpu ?? tiers.find(isCpuRow) ?? tiers[0]!;
}

/** Is this the row for the largest machines? (A status says "the largest model" of it.) */
export function isTopTier(tier: Pick<HardwareTier, 'id'>, tiers: readonly HardwareTier[] = HARDWARE_TIERS): boolean {
  return tiers[tiers.length - 1]?.id === tier.id;
}

// ---------------------------------------------------------------------------
// names and sizes, by tag

/** `Name:Latest` and `name` are one model. */
const canonicalTag = (model: string): string => model.trim().toLowerCase().replace(/:latest$/, '');

function tableEntry(model: string): { name: string; downloadGb: number } | undefined {
  const want = canonicalTag(model);
  for (const t of HARDWARE_TIERS) {
    if (canonicalTag(t.model) === want) return { name: t.name, downloadGb: t.downloadGb };
    if (t.fallbackModel && t.fallbackName && t.fallbackDownloadGb !== undefined && canonicalTag(t.fallbackModel) === want) return { name: t.fallbackName, downloadGb: t.fallbackDownloadGb };
  }
  if (canonicalTag(EMBEDDING_MODEL.model) === want) return { name: EMBEDDING_MODEL.name, downloadGb: EMBEDDING_MODEL.downloadGb };
  return undefined;
}

const capital = (w: string): string => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

/**
 * One word of a model's name: "qwen2.5" is "Qwen 2.5", "r1" is "R1", "coder"
 * is "Coder". A family with a version and a short tail is read as the three
 * things it is: "gemma3n" is "Gemma 3n" (one letter stays on the version),
 * "qwen2.5vl" is "Qwen 2.5 VL" (two or three are a word of their own).
 */
function nameWord(w: string): string {
  const versioned = /^([a-z]{3,})(\d+(?:\.\d+)*)([a-z]{0,3})$/i.exec(w);
  if (versioned) {
    const tail = versioned[3]!;
    return `${capital(versioned[1]!)} ${versioned[2]!}${tail.length === 0 ? '' : tail.length === 1 ? tail.toLowerCase() : ` ${tail.toUpperCase()}`}`;
  }
  return /\d/.test(w) || w.length === 1 ? w.toUpperCase() : capital(w);
}

/**
 * A readable name made from a tag Flint has no name for: "qwen3.6:35b" is
 * "Qwen 3.6 35B". The last path segment, its words capitalised, a version
 * split from its family, and sizes and quantisations in capitals. Never the
 * raw tag: only letters, digits, spaces and . + - come out, 40 characters at
 * most.
 *
 * What is not part of a name is left out: the file format ("gguf"), and a
 * publisher's prefix that only repeats the family ("Qwen_Qwen3-30B" is
 * "Qwen 3 30B", not "Qwen Qwen 3 30B"). A quantisation stays one word:
 * "q4_K_M" is "Q4-K-M", not three loose letters.
 */
export function derivedModelName(model: string): string {
  const last = (model.trim().split('/').pop() ?? '').replace(/\.gguf$/i, '');
  const colon = last.indexOf(':');
  const family = colon < 0 ? last : last.slice(0, colon);
  const variant = colon < 0 ? '' : last.slice(colon + 1);
  // In the variant an underscore joins the parts of one thing (a quantisation: q4_K_M); elsewhere it separates words.
  const variantWords = /^latest$/i.test(variant) ? [] : variant.split(/-+/).map((w) => w.replace(/_+/g, '-'));
  const raw = [...family.split(/[-_]+/), ...variantWords]
    .map((w) => w.replace(/[^A-Za-z0-9.+-]/g, '').replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 0 && !/^gguf$/i.test(w));
  // A word that the next one only repeats and extends is a publisher's prefix, not part of the name.
  const words = raw.filter((w, i) => !(i + 1 < raw.length && /^[a-z]+$/i.test(w) && raw[i + 1]!.length > w.length && raw[i + 1]!.toLowerCase().startsWith(w.toLowerCase()))).map(nameWord);
  const name = words.join(' ').replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40).trim();
  return name.length > 0 ? name : 'Local Model';
}

/** How the console names a model: the table's name for a model it lists, else one made from the tag. */
export function modelDisplayName(model: string): string {
  return tableEntry(model)?.name ?? derivedModelName(model);
}

/** A model's download size in GB, when the table lists it. */
export function modelDownloadGb(model: string): number | undefined {
  return tableEntry(model)?.downloadGb;
}

/** The table as markdown, so a README can never drift from the data (a test compares them). */
export function hardwareTiersMarkdown(tiers: readonly HardwareTier[] = HARDWARE_TIERS): string {
  const n = (x: number): string => x.toLocaleString('en-US');
  const lines = ['| Tier | Machine | Model | Context | Standby model | Standby context | Download | Measured |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  // What a row's machine is reads the NEXT row of its kind: a row ends where the one above it begins.
  const machine = (t: HardwareTier): string => {
    if (isCpuRow(t)) {
      const next = tiers.filter(isCpuRow).find((o) => o.minSystemGb > t.minSystemGb);
      if (next) return t.minSystemGb > 0 ? `no usable GPU, ${t.minSystemGb} GB to under ${next.minSystemGb} GB of RAM` : `no usable GPU, under ${next.minSystemGb} GB of RAM`;
      return t.minSystemGb > 0 ? `no usable GPU, ${t.minSystemGb} GB of RAM or more` : 'no usable GPU';
    }
    const next = tiers.filter((o) => !isCpuRow(o) && o.minGb > t.minGb).sort((a, b) => a.minGb - b.minGb)[0];
    return next ? `${t.minGb} GB to under ${next.minGb} GB of usable memory` : `${t.minGb} GB of usable memory or more`;
  };
  for (const t of tiers) {
    const standby = t.fallbackModel ? `\`${t.fallbackModel}\` (${t.fallbackName})` : 'none';
    const download = `${t.downloadGb.toFixed(1)} GB${t.fallbackDownloadGb !== undefined ? ` + ${t.fallbackDownloadGb.toFixed(1)} GB` : ''}`;
    lines.push(
      `| ${t.label} | ${machine(t)} | \`${t.model}\` (${t.name}) | ${n(t.contextLength)} | ${standby} | ${t.fallbackContextLength !== undefined ? n(t.fallbackContextLength) : 'none'} | ${download} | ${t.measured ? 'yes' : 'recommended, unmeasured'} |`,
    );
  }
  return lines.join('\n');
}
