/**
 * The hands-free voice client (apps/voice/voice_client.py) and a reply that
 * stays on this Mac (P3 part 4). It used to send every reply's text to
 * `/speak`, an outside speech service. Now it reads the chat stream's `meta`
 * event: a reply marked as staying here is spoken with this Mac's own `say`
 * voice and never sent; any other names its conversation and turn, and a
 * refusal from the server (409) falls back to `say` too.
 *
 * The client's own functions are run by python3, with its network and its
 * process calls replaced: nothing is sent, nothing is spoken, and nothing
 * under the real home directory is read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VOICE_DIR = join(__dirname, '..', '..', 'voice');
const hasPython = spawnSync('python3', ['--version']).status === 0;

/** Run `body` inside the client's module, with urlopen and subprocess.run recorded. Its `out` dict comes back. */
function run(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'flint-voice-'));
  const script = `
import sys, json, io
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(VOICE_DIR)})
import voice_client as v
import urllib.error
sent, ran, out = [], [], {}
class Answer:
    def __init__(self, data): self.data = data
    def read(self): return self.data
    def __iter__(self): return iter(self.data.splitlines(True))
def answer_with(status=200, data=b"mp3-bytes"):
    def urlopen(req, timeout=None):
        sent.append({"url": req.full_url, "body": json.loads(req.data.decode())})
        if status != 200: raise urllib.error.HTTPError(req.full_url, status, "refused", {}, io.BytesIO(b"{}"))
        return Answer(data)
    v.urllib.request.urlopen = urlopen
v.subprocess.run = lambda args, **kw: ran.append([args[0]] + ([args[-1]] if args[0] == "say" else []))
v.os.remove = lambda p: None
answer_with()
${body}
print(json.dumps({"sent": sent, "ran": ran, "out": out}))
`;
  try {
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, FLINT_TOKEN: 'test-token-not-real', FLINT_URL: 'http://flint.test' } });
    if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const sse = (events: unknown[]) => JSON.stringify(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));

describe.skipIf(!hasPython)('apps/voice: a reply that stays on this Mac', () => {
  it('reads from the chat stream whether the reply stays here, and which turn it is: the last ask that said so is the one whose text it is', () => {
    const r = run(`
out["marked"] = v.read_reply(${sse([{ type: 'meta', brain: 'local' }, { type: 'meta', staysHere: true, turn: 'turn_abc' }, { type: 'text', delta: 'Your goal ' }, { type: 'text', delta: 'is on track.' }, { type: 'done' }])}.splitlines())
out["plain"] = v.read_reply(${sse([{ type: 'meta', brain: 'frontier' }, { type: 'meta', staysHere: false, turn: 'turn_def' }, { type: 'text', delta: 'It is sunny.' }])}.splitlines())
out["fellBack"] = v.read_reply(${sse([{ type: 'meta', staysHere: false, turn: 't1' }, { type: 'meta', staysHere: true, turn: 't2' }, { type: 'text', delta: 'From the local model.' }])}.splitlines())
out["older"] = v.read_reply(${sse([{ type: 'meta', brain: 'local' }, { type: 'text', delta: 'An older server.' }])}.splitlines())
out["odd"] = v.read_reply([b"data: not json", b": comment", b'data: {"type":"meta","staysHere":"true","turn":7}', b'data: ["x"]', b'data: {"type":"text","delta":"ok"}'])
`);
    expect(r.out).toEqual({
      marked: ['Your goal is on track.', true, 'turn_abc'],
      plain: ['It is sunny.', false, 'turn_def'],
      fellBack: ['From the local model.', true, 't2'],
      older: ['An older server.', false, null],
      odd: ['ok', false, null],
    });
  });

  it('a reply that stays here is spoken with this Mac’s own voice, and /speak is never asked', () => {
    const r = run(`v.speak("Your goal is on track.", True, "turn_abc")`);
    expect(r.sent).toEqual([]);
    expect(r.ran).toEqual([['say', 'Your goal is on track.']]);
  });

  it('any other reply goes to /speak, naming its conversation and turn', () => {
    const r = run(`
v.speak("It is sunny.", False, "turn_def")
v.speak("Yeah?")
`);
    expect(r.sent).toEqual([
      { url: 'http://flint.test/speak', body: { text: 'It is sunny.', conversationId: 'voice', turnId: 'turn_def' } },
      { url: 'http://flint.test/speak', body: { text: 'Yeah?', conversationId: 'voice' } },
    ]);
    expect(r.ran).toEqual([['afplay'], ['afplay']]);
  });

  it('when the server refuses (409: the reply stays here) or fails, this Mac’s own voice speaks it', () => {
    for (const status of [409, 503, 500]) {
      const r = run(`
answer_with(${status})
v.speak("Your goal is on track.", False, "turn_abc")
`);
      expect(r.sent, String(status)).toHaveLength(1);
      expect(r.ran, String(status)).toEqual([['say', 'Your goal is on track.']]);
    }
  });

  it('a whole exchange: the chat is asked in the client’s own conversation, and a marked reply’s text goes nowhere but `say`', () => {
    const r = run(`
answer_with(200, ${sse([{ type: 'meta', staysHere: true, turn: 'turn_abc' }, { type: 'text', delta: 'Your goal is on track.' }])}.encode())
reply, here, turn = v.ask_flint("how are my goals going?")
v.speak(reply, here, turn)
out["reply"] = [reply, here, turn]
`);
    expect(r.out).toEqual({ reply: ['Your goal is on track.', true, 'turn_abc'] });
    expect(r.sent).toEqual([{ url: 'http://flint.test/chat', body: { conversationId: 'voice', message: 'how are my goals going?' } }]);
    expect(r.ran).toEqual([['say', 'Your goal is on track.']]);
  });
});
