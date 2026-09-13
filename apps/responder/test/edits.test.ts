import { describe, it, expect } from 'vitest';
import { applyEdits } from '../src/edits.js';

/*
 * A revision used to be the whole file again. What these cover is that an edit lands
 * exactly where it was aimed, and that anything ambiguous or missing changes nothing.
 */

const built = [{ name: 'style.css', content: 'body { color: red; }\n.btn { padding: 4px; }\n' }];

describe('applyEdits', () => {
  it('replaces one exact match and returns the whole file', () => {
    const { files, failed } = applyEdits([{ name: 'style.css', find: 'padding: 4px', replace: 'padding: 12px', note: 'bigger' }], [], built);
    expect(failed).toEqual([]);
    expect(files).toEqual([{ name: 'style.css', content: 'body { color: red; }\n.btn { padding: 12px; }\n', note: 'bigger' }]);
  });

  it('applies several edits to the same file in order', () => {
    const { files } = applyEdits(
      [
        { name: 'style.css', find: 'red', replace: 'blue' },
        { name: 'style.css', find: 'blue', replace: 'green' },
      ],
      [],
      built,
    );
    expect(files[0]?.content).toContain('color: green');
  });

  it('refuses text that is not there, and leaves the file out of what is written', () => {
    const { files, failed } = applyEdits([{ name: 'style.css', find: 'margin: 0', replace: 'margin: 1px' }], [], built);
    expect(files).toEqual([]);
    expect(failed[0]?.reason).toMatch(/not in the file/);
  });

  it('refuses text that appears more than once', () => {
    const { failed } = applyEdits([{ name: 'style.css', find: ' { ', replace: '{' }], [], built);
    expect(failed[0]?.reason).toMatch(/more than once/);
  });

  it('refuses a file the thread does not have', () => {
    const { failed } = applyEdits([{ name: 'nope.js', find: 'a', replace: 'b' }], [], built);
    expect(failed[0]?.reason).toMatch(/no such file/);
  });

  it('edits a file sent whole in the same turn, on top of what was sent', () => {
    const sent = [{ name: 'style.css', content: 'p { margin: 0 }', note: null }];
    const { files } = applyEdits([{ name: 'style.css', find: 'margin: 0', replace: 'margin: 8px' }], sent, built);
    expect(files).toEqual([{ name: 'style.css', content: 'p { margin: 8px }', note: null }]);
  });

  /* Models quote a snippet with a line break on each end that the file does not have there. */
  it('forgives line breaks around the text to find', () => {
    const { files, failed } = applyEdits([{ name: 'style.css', find: '\ncolor: red\n', replace: 'color: black' }], [], built);
    expect(failed).toEqual([]);
    expect(files[0]?.content).toContain('color: black');
  });

  it('refuses an edit that would empty the file', () => {
    const { failed } = applyEdits([{ name: 'style.css', find: built[0]!.content, replace: '  ' }], [], built);
    expect(failed[0]?.reason).toMatch(/empty/);
  });
});
