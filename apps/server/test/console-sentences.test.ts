/**
 * The console's own lines are sentences (Will, 2026-10-06: "All secondary text
 * should be complete and concise sentences"), checked on the main script's
 * functions run against small fakes: an error in Flint's words ends with a stop
 * and never doubles one; a reply that stops mid-stream says so in a sentence and
 * never prints the server's raw error (that goes to the console log); a refused
 * or unanswered message says so; and a Mac whose key was revoked can replace it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;

/** One top-level function of the main script, up to the next top-level statement. */
function fn(name: string): string {
  const start = mainJs.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const rest = mainJs.slice(start + 1);
  const end = rest.slice(1).search(/\n(function |\/\*|\$\(|var )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

class El {
  value = '';
  hidden = false;
  children: El[] = [];
  style: Record<string, string> = {};
  scrollTop = 0;
  textContent = '';
  innerHTML = '';
  constructor(readonly id = '') {}
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('errText', () => {
  const c: Record<string, unknown> = {};
  createContext(c);
  runInContext(fn('errText'), c);
  const say = (e: unknown) => (c.errText as (e: unknown) => string)(e);

  it('is a sentence: a capital first and a stop last, never two', () => {
    expect(say('the runtime refused that change')).toBe('The runtime refused that change.');
    expect(say(new Error('That key is already added.'))).toBe('That key is already added.');
    expect(say('Is it there?')).toBe('Is it there?');
    expect(say('Flint is waiting…')).toBe('Flint is waiting…');
    expect(say('a list follows:')).toBe('A list follows.');
    // An aside is left out, as before.
    expect(say('the database refused it (err123)')).toBe('The database refused it.');
  });

  it('a cancelled prompt is "Cancelled.", and nothing at all is "It stopped."', () => {
    expect(say(new Error('not confirmed'))).toBe('Cancelled.');
    expect(say(undefined)).toBe('It stopped.');
    expect(say('(only an aside)')).toBe('It stopped.');
  });
});

describe('the console asking Flint', () => {
  function chat(answer: () => Promise<unknown>) {
    const ids: Record<string, El> = Object.fromEntries(['input', 'thread', 'think', 'transcript'].map((id) => [id, new El(id)]));
    ids.input!.value = 'Hello';
    const bodies: El[] = [];
    const logged: unknown[][] = [];
    const c: Record<string, unknown> = {
      $: (id: string) => ids[id],
      ATT_READING: 0, PENDING: [], TOKEN: 'tok', BASE: '', convId: 'c1', LOCAL_ONLY: false, _ttsGen: 0,
      attNote: () => {}, openSettings: () => {}, syncSend: () => {}, renderChips: () => {}, setTitle: () => {}, renderSentAtts: () => {},
      stopSpeech: () => {}, setTalk: () => {}, tokenRejected: () => {}, setBrainChip: () => {}, renderProposals: () => {}, speakSynced: () => {}, loadThreads: () => {},
      addMsg: () => {
        const b = new El();
        bodies.push(b);
        return b;
      },
      auth: () => ({ Authorization: 'Bearer tok' }),
      md: (s: string) => s,
      fetch: answer,
      TextDecoder,
      console: { log: (...a: unknown[]) => void logged.push(a) },
    };
    createContext(c);
    runInContext(`${fn('errText')}\n${fn('send')}`, c);
    return { send: () => runInContext('send()', c), reply: () => bodies[1]!, logged };
  }
  const stream = (...events: unknown[]) => async () => {
    const chunks = events.map((e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
    return { status: 200, ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  };

  it('a reply that stops mid-stream says so in a sentence; the server\'s error goes to the console log, never into the reply', async () => {
    for (const error of [{ message: 'upstream reset: ECONNRESET' }, 'Error: socket hang up', { kind: 'timeout' }]) {
      const t = chat(stream({ type: 'text', delta: 'Partly there' }, { type: 'error', error }));
      t.send();
      await settle();
      expect(t.reply().innerHTML).toBe('Partly there\n\nThis reply stopped early.');
      expect(t.reply().innerHTML).not.toMatch(/object Object|Error:|ECONNRESET|timeout/);
      expect(t.logged).toEqual([['Flint: the reply stopped early:', error]]);
    }
  });

  it('a reply stopped because no brain has budget left says why and what to do, from the sentence the server wrote for Will', async () => {
    const message = "Claude (Anthropic) budget reached: today's $10.00 cap is spent. No brain with budget left can answer, so none was called. Ask again after the budget resets, or raise the cap (FLINT_BUDGET_ANTHROPIC_*).";
    const error = `Error: frontier failed: Error: 529 overloaded. ${message}`;
    const t = chat(stream({ type: 'error', error, message }));
    t.send();
    await settle();
    expect(t.reply().innerHTML).toBe(
      "\n\nThis reply stopped early. Claude budget reached: today's $10.00 cap is spent. No brain with budget left can answer, so none was called. Ask again after the budget resets, or raise the cap.",
    );
    // The raw error stays in the console log only.
    expect(t.reply().innerHTML).not.toMatch(/frontier failed|529|Error:/);
    expect(t.logged).toEqual([['Flint: the reply stopped early:', error]]);
  });

  it('a refused message says it was not sent, in Flint\'s words; no answer at all says so', async () => {
    const refused = chat(async () => ({ status: 413, ok: false, json: async () => ({ error: 'that file is over the 20 MB limit' }) }));
    refused.send();
    await settle();
    expect(refused.reply().textContent).toBe('This message wasn’t sent. That file is over the 20 MB limit.');
    const bare = chat(async () => ({ status: 500, ok: false, json: async () => { throw new Error('not JSON'); } }));
    bare.send();
    await settle();
    expect(bare.reply().textContent).toBe('This message wasn’t sent. Flint returned error 500.');
    const down = chat(async () => { throw new TypeError('Failed to fetch'); });
    down.send();
    await settle();
    expect(down.reply().textContent).toBe('Flint didn’t answer. Try again.');
  });
});

describe('a card a chat proposed', () => {
  it('says a chat filed it, even when the server sent it without its origin', () => {
    const host = { children: [] as Array<{ children: Array<{ cls: string; text: string }> }>, appendChild(c: { children: Array<{ cls: string; text: string }> }) { this.children.push(c); return c; } };
    const subs: unknown[] = [];
    const c: Record<string, unknown> = {
      $: () => ({ scrollTop: 0 }),
      el: (_tag: string, cls?: string, text?: string) => ({ cls, text, children: [] as unknown[], classList: { toggle() {}, contains: () => false }, style: {}, appendChild(x: unknown) { this.children.push(x); return x; } }),
      apprTitle: (a: { fullName: string }) => a.fullName,
      apprSub: (a: { origin?: string }) => (subs.push(a.origin), a.origin && a.origin.indexOf('chat:') === 0 ? 'A chat filed this.' : 'Its source is unknown.'),
      apprAlone: () => false, approveLabel: () => 'Approve', approveAction: () => {}, rejectAction: () => {},
    };
    createContext(c);
    runInContext(fn('renderProposals'), c);
    (c.renderProposals as (a: unknown[], b: unknown) => void)([{ id: 'act-1', fullName: 'github.create_issue', args: {}, tainted: false, status: 'pending' }, { id: 'pr2', fullName: 'github.create_issue', args: {}, tainted: false, status: 'pending', origin: 'chat:t1' }], { parentNode: host });
    expect(subs).toEqual(['chat:', 'chat:t1']);
    expect(host.children.map((card) => card.children.find((x) => x.cls === 'psub')!.text)).toEqual(['A chat filed this.', 'A chat filed this.']);
  });
});

describe('Settings: Approval Keys', () => {
  function keys(o: { seId: string | null; listed: Array<{ credentialId: string; factor: string; label: string }> }) {
    const ids: Record<string, El> = Object.fromEntries(['creds', 'enrollbox', 'enrollpk', 'enrollse', 'resetse'].map((id) => [id, new El(id)]));
    const c: Record<string, unknown> = {
      $: (id: string) => ids[id],
      TOKEN: 'tok', BASE: '', SE_ID: o.seId, SE_METHOD: 'touchid', CREDS: null,
      auth: () => ({ Authorization: 'Bearer tok' }),
      enclave: () => ({}), passkeysHere: () => false, loadKeyApprovals: () => {}, resetEnclave: () => {},
      el: (_tag: string, _cls?: string, text?: string) => Object.assign(new El(), { textContent: text ?? '', appendChild(x: El) { this.children.push(x); return x; } }),
      fetch: async () => ({ ok: true, json: async () => ({ credentials: o.listed }) }),
    };
    createContext(c);
    runInContext(`${fn('keyRow')}\n${fn('loadCreds')}`, c);
    (ids.creds as unknown as { appendChild: (x: El) => El }).appendChild = (x: El) => (ids.creds!.children.push(x), x);
    runInContext('loadCreds()', c);
    return ids;
  }

  it('offers Replace This Mac’s Key whenever this Mac has a key that is not enrolled (one that was revoked is not listed)', async () => {
    const revoked = keys({ seId: 'se_revoked', listed: [{ credentialId: 'pk1', factor: 'webauthn', label: 'phone' }] });
    await settle();
    expect(revoked.resetse!.hidden).toBe(false);
    const enrolled = keys({ seId: 'se_mine', listed: [{ credentialId: 'se_mine', factor: 'secure_enclave', label: 'Mac' }] });
    await settle();
    expect(enrolled.resetse!.hidden).toBe(false);
    // No key on this Mac yet: nothing to replace, so Add is the way.
    const none = keys({ seId: null, listed: [] });
    await settle();
    expect(none.resetse!.hidden).toBe(true);
  });
});
