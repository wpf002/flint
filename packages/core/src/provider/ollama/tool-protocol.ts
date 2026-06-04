import type { ToolDefinition } from '../../types/tool.js';

/**
 * The prompted tool-calling protocol. Local models have no native tool API, so
 * the adapter OWNS the contract (spec §10): it instructs the model to emit a
 * specific JSON shape to request a tool, then parses-and-repairs that JSON out
 * of the model's free text. The contract suite is what proves this works.
 *
 * Wire shape the model is asked to emit:
 *   {"tool_call": {"name": "<tool>", "arguments": { ... }}}
 */

export function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input JSON schema: ${JSON.stringify(t.inputSchema)}`)
    .join('\n');

  return [
    'You can call tools. When you need a tool, respond with ONLY a single JSON',
    'object and nothing else, in exactly this shape:',
    '{"tool_call": {"name": "<tool_name>", "arguments": { ...json args... }}}',
    'Do not wrap it in markdown, do not add prose before or after it.',
    'If you do NOT need a tool, answer the user normally in plain text.',
    '',
    'Available tools:',
    list,
  ].join('\n');
}

export interface ParsedToolCall {
  name: string;
  arguments: unknown;
}

/**
 * Tolerantly extract a tool call from model output. Handles the common ways a
 * local model deviates: markdown code fences, leading/trailing prose, trailing
 * commas, and single quotes. Returns null when no tool call is present.
 */
export function extractToolCall(text: string): ParsedToolCall | null {
  const candidate = findJsonObject(stripFences(text));
  if (!candidate) return null;

  const parsed = tolerantParse(candidate);
  if (!parsed || typeof parsed !== 'object') return null;

  const tc = (parsed as Record<string, unknown>).tool_call;
  if (!tc || typeof tc !== 'object') return null;

  const name = (tc as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.length === 0) return null;

  const args = (tc as Record<string, unknown>).arguments ?? {};
  return { name, arguments: args };
}

function stripFences(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

/** Find the first balanced top-level {...} object in the text. */
function findJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tolerantParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // Light repair: drop trailing commas, normalize single quotes.
    const repaired = json
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'/g, '"');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}
