/**
 * Flint's orb is never under text (Will, 2026-10-05), and it is part of the main
 * column rather than wedged beside it: it stands at the top of the chat, below the
 * header, centred over "How can I help?" in a new chat and in a band above the
 * messages in a conversation. Nothing shares its box, the messages scroll below
 * it, and a panel (which covers the window) makes it step away. The orb itself is
 * Flint's own canvas, drawn full size and scaled whole to fit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
// Rules outside any @media block apply at every window size.
const base = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

describe('the orb, in the main column with no text over it', () => {
  it('stands first in the chat column, holding the orb and nothing else', () => {
    const stage = /<section class="chat" id="chat">\s*<div class="stage" id="stage">([\s\S]*?)<\/div>\s*<div id="transcript">/.exec(html)![1]!;
    expect(stage.replace(/\s+/g, '')).toBe('<divid="brainwrap"><canvasid="brain"></canvas><divclass="think"id="think"></div></div>');
    // One column: no grid track beside the chat for the orb to stand in.
    expect(base).toContain('.main{grid-column:2;position:relative;display:flex;min-width:0;min-height:0;}');
    expect(html).not.toContain('stageBeside');
  });

  it('a new chat centres it over "How can I help?", the two stacked in the flow', () => {
    expect(base).toContain('.main.empty .stage{height:var(--orb-hero);margin-top:auto;}');
    expect(base).toMatch(/\.empty-state\{display:flex;flex-direction:column;[^}]*margin-bottom:auto;/);
    expect(base).not.toMatch(/\.empty-state\{[^}]*position:absolute/);
    expect(base).toContain('.main.empty #transcript{display:none;}');
    expect(html.indexOf('id="stage"')).toBeLessThan(html.indexOf('id="emptystate"'));
  });

  it('a conversation keeps it in a band above the messages, which scroll below it', () => {
    expect(base).toContain('.stage{position:relative;flex:none;height:calc(460px * var(--band-scale));overflow:hidden;}');
    expect(base).toMatch(/#transcript\{flex:1;overflow:auto;/);
  });

  it('sits below the header, where the FLINT mark stays; the leading tooltips open sideways', () => {
    const header = /<header class="top" id="top">([\s\S]*?)<\/header>/.exec(html)![1]!;
    expect(header).toContain('<div class="brand" aria-hidden="true"><span class="sp"></span><span class="nm">FLINT</span></div>');
    expect(base).toMatch(/\.chat\{[^}]*padding-top:var\(--hdr\);\}/);
    expect(css).toContain('.grp [data-tip]:hover::after,.grp [data-tip]:focus-visible::after{top:50%;left:calc(100% + 6px);transform:translateY(-50%);}');
  });

  it('a panel covers the window and the orb steps away under it, at every size', () => {
    expect(base).toMatch(/\.overlay\{position:fixed;inset:0;/);
    expect(base).toContain('body.panel-open .stage{visibility:hidden;}');
    expect(html).toContain("if(!still&&typeof panelOpen==='function'&&panelOpen()){requestAnimationFrame(frame);return;}");
  });

  it('is Flint’s own canvas, ~520 particles with their neighbour lines, drawn full size and scaled whole', () => {
    expect(html).toContain('var N=520,P=[];');
    expect(html).toContain("ctx.strokeStyle='rgba(255,165,60,'");
    expect(base).toContain('#brainwrap{position:absolute;top:0;left:50%;width:760px;height:460px;margin-left:-380px;transform:scale(var(--orb-k,var(--band-scale)));transform-origin:50% 0;}');
    // The canvas sizes by its layout box (760×460), not the scaled box on screen.
    expect(html).toContain('W=cvs.clientWidth;H=cvs.clientHeight;');
    expect(html).toContain("function fitOrb(){var h=$('stage').clientHeight;if(h)document.documentElement.style.setProperty('--orb-k',String(Math.min(1,h/460)));}");
  });
});
