/**
 * Flint's orb is never under text (Will, 2026-10-05): its stage holds the orb
 * and nothing else, starts below the header (so no button, tooltip or the
 * FLINT mark sits on it), and panels open over the chat side, from where the
 * stage ends; on a narrow window, where a panel covers everything, the stage
 * steps away while the panel is open. The orb itself is Flint's own canvas.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;

describe('no text over the orb', () => {
  it('the stage holds the orb and nothing else', () => {
    const stage = /<div class="stage" id="stage">([\s\S]*?)<\/div>\s*<section class="chat"/.exec(html)![1]!;
    expect(stage.replace(/\s+/g, '')).toBe('<divid="brainwrap"><canvasid="brain"></canvas><divclass="think"id="think"></div></div>');
  });

  it('the FLINT mark is in the header bar, and the stage starts below the header', () => {
    const header = /<header class="top" id="top">([\s\S]*?)<\/header>/.exec(html)![1]!;
    expect(header).toContain('<div class="brand" aria-hidden="true"><span class="sp"></span><span class="nm">FLINT</span></div>');
    expect(css).toContain('#brainwrap{position:absolute;inset:var(--hdr) 0 0 0;}');
    // The leading buttons' tooltips open sideways, inside the header, not down onto the stage.
    expect(css).toContain('.grp [data-tip]:hover::after,.grp [data-tip]:focus-visible::after{top:50%;left:calc(100% + 6px);transform:translateY(-50%);}');
  });

  it('panels open from where the stage ends; on a narrow window the stage steps away under a panel', () => {
    expect(css).toMatch(/\.overlay\{position:fixed;top:0;right:0;bottom:0;left:var\(--stage-edge,0px\);/);
    expect(css).toContain('body.panel-open .stage{visibility:hidden;}');
    expect(html).toContain("function syncStageEdge(){document.documentElement.style.setProperty('--stage-edge',stageBeside()+'px');}");
  });

  it('the orb is Flint’s own canvas: ~520 particles with their neighbour lines', () => {
    expect(html).toContain('var N=520,P=[];');
    expect(html).toContain("ctx.strokeStyle='rgba(255,165,60,'");
  });
});
