import type { Tool } from '@flint/core';

/**
 * Deterministic watch triggers (Phase 5). "Watch X, when Y, alert Z" —
 * evaluated by CODE, not the model: a trigger calls a (read-only) tool, selects
 * a value from the result, and compares it to a threshold. No LLM in the firing
 * decision, so an alert is auditable and can't hallucinate (the honest, solvable
 * kind of proactivity; open-ended judgment stays out of this path).
 */

export type CompareOp = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'contains';

export interface Trigger {
  name: string;
  /** A read-only tool to call (e.g. 'meridian.bias_summary'). */
  tool: string;
  args?: unknown;
  /** Path into the tool's (JSON) result; '*' walks arrays/objects. E.g. '*.score'. */
  select: string;
  when: { op: CompareOp; value: number | string };
  /** Message to surface when it fires. */
  alert: string;
}

export interface TriggerResult {
  name: string;
  fired: boolean;
  /** The selected values that satisfied the condition. */
  matched: unknown[];
  alert?: string;
  error?: string;
}

/** Walk a `select` path (dot-separated, '*' = each array item / object value). */
export function selectValues(value: unknown, path: string): unknown[] {
  if (!path) return [value];
  let current: unknown[] = [value];
  for (const part of path.split('.')) {
    const next: unknown[] = [];
    for (const c of current) {
      if (part === '*') {
        if (Array.isArray(c)) next.push(...c);
        else if (c && typeof c === 'object') next.push(...Object.values(c));
      } else if (c && typeof c === 'object') {
        next.push((c as Record<string, unknown>)[part]);
      }
    }
    current = next.filter((x) => x !== undefined);
  }
  return current;
}

function compare(v: unknown, op: CompareOp, value: number | string): boolean {
  switch (op) {
    case '>': return Number(v) > Number(value);
    case '<': return Number(v) < Number(value);
    case '>=': return Number(v) >= Number(value);
    case '<=': return Number(v) <= Number(value);
    case '==': return v === value;
    case '!=': return v !== value;
    case 'contains': return typeof v === 'string' && v.includes(String(value));
    default: return false;
  }
}

function parseResult(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Evaluate triggers against the given tools. Returns a result per trigger; a
 * fired result carries the matched values and the rendered alert.
 */
export async function evaluateTriggers(
  triggers: Trigger[],
  tools: Tool[],
): Promise<TriggerResult[]> {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const results: TriggerResult[] = [];

  for (const trig of triggers) {
    const tool = byName.get(trig.tool);
    if (!tool) {
      results.push({ name: trig.name, fired: false, matched: [], error: `unknown tool '${trig.tool}'` });
      continue;
    }
    try {
      const raw = await tool.handler({ id: `trigger:${trig.name}`, toolName: trig.tool, args: trig.args ?? {} });
      const values = selectValues(parseResult(raw), trig.select);
      const matched = values.filter((v) => compare(v, trig.when.op, trig.when.value));
      const fired = matched.length > 0;
      results.push({
        name: trig.name,
        fired,
        matched,
        ...(fired ? { alert: `${trig.alert} — matched ${JSON.stringify(matched)}` } : {}),
      });
    } catch (err) {
      results.push({ name: trig.name, fired: false, matched: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
