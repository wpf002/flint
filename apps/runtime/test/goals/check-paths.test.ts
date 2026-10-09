/**
 * The checks a goal may make of an item (CHECK_PATHS, @flint/policy) are fields
 * and values the world model really has (world/kinds.ts): each path is a field of
 * that kind's state, and its values are exactly that field's enum, so a value
 * added to one and not the other fails here.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { CHECK_PATHS, checkFits } from '@flint/policy';
import { STATE } from '../../src/world/kinds';

/** The enum under a field's optional and nullable wrappers. */
function enumOf(t: z.ZodTypeAny): readonly string[] | undefined {
  let f = t;
  while (f instanceof z.ZodOptional || f instanceof z.ZodNullable) f = f.unwrap();
  return f instanceof z.ZodEnum ? (f.options as string[]) : undefined;
}

describe('CHECK_PATHS', () => {
  it('names only fields the world model keeps, with exactly their values', () => {
    for (const [kind, paths] of Object.entries(CHECK_PATHS)) {
      const state = STATE[kind];
      expect(state, kind).toBeInstanceOf(z.ZodObject);
      for (const [key, values] of Object.entries(paths)) {
        const field = (state as z.ZodObject<z.ZodRawShape>).shape[key];
        expect(field, `${kind}.${key}`).toBeDefined();
        expect([...(enumOf(field!) ?? [])].sort(), `${kind}.${key}`).toEqual([...values].sort());
        for (const v of values) expect(field!.safeParse(v).success, `${kind}.${key} = ${v}`).toBe(true);
      }
    }
  });

  it('never reaches a name, a title, a person or a calendar event', () => {
    for (const paths of Object.values(CHECK_PATHS)) for (const key of Object.keys(paths)) expect(['name', 'title', 'email', 'labels']).not.toContain(key);
    for (const kind of ['person', 'commitment', 'deadline', 'account', 'repo']) expect(CHECK_PATHS[kind], kind).toBeUndefined();
    expect(checkFits('pull_request', 'title', 'Ship it')).toBe(false);
  });
});
