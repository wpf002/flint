/**
 * The hands-free voice client (apps/voice/voice_client.py) and a reply that
 * stays on this Mac (P3 part 4). It used to send every reply's text to
 * `/speak`, an outside speech service. Now it reads the chat stream's `meta`
 * event: a reply marked as staying here is spoken with this Mac's own `say`
 * voice and never sent; any other names its conversation and turn, and a
 * refusal from the server (409) falls back to `say` too.
 *
 * Local voice: when the server's own speech is made on this Mac, the same
 * event says so (`speechHere`), and only then is a reply that stays here sent
 * to `/speak`. The audio is played as the kind the server says it is.
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
    def __init__(self, data, kind): self.data = data; self.headers = {} if kind is None else {"content-type": kind}
    def read(self): return self.data
    def __iter__(self): return iter(self.data.splitlines(True))
    def __enter__(self): return self
    def __exit__(self, *a): return False
def answer_with(status=200, data=b"mp3-bytes", kind="audio/mpeg"):
    def urlopen(req, timeout=None):
        sent.append({"url": req.full_url, "body": json.loads(req.data.decode())})
        if status != 200: raise urllib.error.HTTPError(req.full_url, status, "refused", {}, io.BytesIO(b"{}"))
        return Answer(data, kind)
    v.urllib.request.urlopen = urlopen
# What was run: say with its words, afplay with the kind of file it was handed (never the file's own name).
v.subprocess.run = lambda args, **kw: ran.append([args[0]] + ([args[-1]] if args[0] == "say" else [v.os.path.splitext(args[-1])[1]]))
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
    // (The fourth: has the server said its own speech is made on this Mac? Not here.)
    expect(r.out).toEqual({
      marked: ['Your goal is on track.', true, 'turn_abc', false],
      plain: ['It is sunny.', false, 'turn_def', false],
      fellBack: ['From the local model.', true, 't2', false],
      // No word from the server that the reply may go out: it stays here.
      older: ['An older server.', true, null, false],
      odd: ['ok', true, null, false],
    });
  });

  it('reads whether the server speaks on this Mac: only its own yes counts, said by the event that names the reply, and the last such event decides', () => {
    const r = run(`
out["here"] = v.read_reply(${sse([{ type: 'meta', staysHere: true, turn: 't1', speechHere: true }, { type: 'text', delta: 'Noted.' }])}.splitlines())
out["notSaid"] = v.read_reply(${sse([{ type: 'meta', staysHere: true, turn: 't1' }, { type: 'text', delta: 'Noted.' }])}.splitlines())
out["takenBack"] = v.read_reply(${sse([{ type: 'meta', staysHere: true, turn: 't1', speechHere: true }, { type: 'meta', staysHere: true, turn: 't2' }, { type: 'text', delta: 'Noted.' }])}.splitlines())
out["brainOnly"] = v.read_reply(${sse([{ type: 'meta', brain: 'local', speechHere: true }, { type: 'text', delta: 'Noted.' }])}.splitlines())
out["notYes"] = [v.read_reply([('data: ' + json.dumps({"type": "meta", "staysHere": True, "turn": "t", "speechHere": x})).encode(), b'data: {"type":"text","delta":"x"}'])[3] for x in ("true", 1, {}, None, False)]
`);
    expect(r.out).toEqual({
      here: ['Noted.', true, 't1', true],
      notSaid: ['Noted.', true, 't1', false],
      takenBack: ['Noted.', true, 't2', false],
      brainOnly: ['Noted.', true, null, false],
      notYes: [false, false, false, false, false],
    });
  });

  it('a reply that stays here is spoken with this Mac’s own voice, and /speak is never asked', () => {
    const r = run(`v.speak("Your goal is on track.", True, "turn_abc")`);
    expect(r.sent).toEqual([]);
    expect(r.ran).toEqual([['say', 'Your goal is on track.']]);
    // ...whatever is passed for "the server speaks here" that is not its own yes.
    const not = run(`
for x in (False, None, "true", 1):
    v.speak("Your goal is on track.", True, "turn_abc", x)
`);
    expect(not.sent).toEqual([]);
    expect(not.ran).toHaveLength(4);
  });

  it('when the server speaks on this Mac, a reply that stays here is sent to it, and played as the kind of audio it came as', () => {
    const r = run(`
answer_with(200, b"m4a-bytes", "audio/mp4")
v.speak("Your goal is on track.", True, "turn_abc", True)
`);
    expect(r.sent).toEqual([{ url: 'http://flint.test/speak', body: { text: 'Your goal is on track.', conversationId: 'voice', turnId: 'turn_abc' } }]);
    expect(r.ran).toEqual([['afplay', '.m4a']]);
    // If that server then refuses or fails, this Mac's own voice speaks it, as for any reply.
    const refused = run(`
answer_with(409)
v.speak("Your goal is on track.", True, "turn_abc", True)
`);
    expect(refused.ran).toEqual([['say', 'Your goal is on track.']]);
  });

  it('the audio is played as the kind the server says it is; anything else is mp3, as it always was', () => {
    const r = run(`
for kind in ("audio/mpeg", "audio/mp4", "audio/wav", "Audio/WAV; charset=binary", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/flac", None, "", "application/json", "audio/../../etc/passwd"):
    answer_with(200, b"bytes", kind)
    v.speak("It is sunny.", False, "turn_def")
out["suffixes"] = [v.audio_suffix(k) for k in ("audio/mp4", "text/html", None)]
`);
    expect((r.ran as string[][]).map((x) => x[1])).toEqual(['.mp3', '.m4a', '.wav', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.mp3', '.mp3', '.mp3', '.mp3']);
    expect(r.out).toEqual({ suffixes: ['.m4a', '.mp3', '.mp3'] });
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
    expect(r.ran).toEqual([['afplay', '.mp3'], ['afplay', '.mp3']]);
  });

  // One reply, one voice. This client asks for a reply's speech in ONE request, whole (the console asks sentence
  // by sentence), so a reply is spoken from its first word to its last by one voice: the server's, or this Mac's.
  it('a long reply is one request, so it is one voice: the server’s for all of it, or this Mac’s own for all of it', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} of a long reply.`).join(' ');
    const spoken = run(`
answer_with(200, b"m4a-bytes", "audio/mp4")
v.speak(${JSON.stringify(long)}, False, "turn_long")
`);
    expect(spoken.sent).toEqual([{ url: 'http://flint.test/speak', body: { text: long, conversationId: 'voice', turnId: 'turn_long' } }]);
    expect(spoken.ran).toEqual([['afplay', '.m4a']]);
    for (const status of [429, 409, 503, 500]) {
      const own = run(`
answer_with(${status})
v.speak(${JSON.stringify(long)}, False, "turn_long")
`);
      // Asked once, refused once, and then this Mac's own voice for the reply: nothing of it is played from the server.
      expect(own.sent, String(status)).toHaveLength(1);
      expect((own.ran as string[][]).map((x) => x[0]), String(status)).toEqual(['say']);
    }
  }, 60_000);

  it('when the server refuses (409: the reply stays here), is busy (429) or fails, this Mac’s own voice speaks it', () => {
    for (const status of [409, 429, 503, 500]) {
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
reply, here, turn, speech_here = v.ask_flint("how are my goals going?")
v.speak(reply, here, turn, speech_here)
out["reply"] = [reply, here, turn, speech_here]
`);
    expect(r.out).toEqual({ reply: ['Your goal is on track.', true, 'turn_abc', false] });
    expect(r.sent).toEqual([{ url: 'http://flint.test/chat', body: { conversationId: 'voice', message: 'how are my goals going?' } }]);
    expect(r.ran).toEqual([['say', 'Your goal is on track.']]);
  });
});
