#!/usr/bin/env python3
"""Hey-Flint voice assistant — hands-free, always-listening (like Alexa).
Runs on the Mac Studio next to Flint. Flow: listen -> hear the wake word
("flint"/"hey flint") -> capture your command -> send to Flint -> speak the reply
in his onyx voice. Reuses whisper-cli (STT) + Flint's /speak (TTS); no cloud
wake-word service.

/speak is an outside speech service (OpenAI). A reply Flint marks as staying on
this Mac (its chat stream's `meta` event says so: a turn answered with Will's
goals, or one that read such a turn) is never sent there: it is spoken with
this Mac's own `say` voice instead. Every other reply's request names its
conversation and turn, so the server can refuse on its side too.

Deps:  pip install sounddevice numpy   (whisper-cli + afplay already on macOS)
Run:   python3 voice_client.py          (tune WAKE_RMS on real hardware)
Env:   FLINT_URL, FLINT_TOKEN, WAKE_WORDS, WHISPER_BIN, WHISPER_MODEL
"""
import os, sys, json, subprocess, tempfile, time, urllib.request, wave
try:
    import numpy as np
    import sounddevice as sd
except ImportError:   # the reply and speech helpers below need neither, and are tested without them
    np = sd = None

FLINT_URL   = os.environ.get("FLINT_URL", "http://localhost:8080")  # Flint listens on ::1
# voice's own token (chat and speech only), made by the server; then FLINT_TOKEN.
_SCOPED = os.path.expanduser("~/.flint/tokens/voice.token")
FLINT_TOKEN = (open(_SCOPED).read().strip() if os.path.exists(_SCOPED) else None) or os.environ.get("FLINT_TOKEN") or subprocess.check_output(
    ["/usr/libexec/PlistBuddy","-c","Print :EnvironmentVariables:FLINT_TOKEN",
     os.path.expanduser("~/Library/LaunchAgents/com.flint.server.plist")]).decode().strip()
WAKE_WORDS  = [w.strip().lower() for w in os.environ.get("WAKE_WORDS","hey flint,flint,okay flint").split(",")]
WHISPER_BIN = os.environ.get("WHISPER_BIN", "/opt/homebrew/bin/whisper-cli")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", os.path.expanduser("~/.flint/models/ggml-base.en.bin"))
SR = 16000
WAKE_RMS = float(os.environ.get("WAKE_RMS", "0.012"))   # speech-vs-silence threshold (tune!)
SILENCE_HANG = 1.0                                        # seconds of quiet that ends an utterance

def rms(x): return float(np.sqrt(np.mean(x.astype(np.float32)**2)) / 32768.0)

def record_utterance(max_s=12):
    """Record from first speech until ~1s of silence (or max_s)."""
    frames, speaking, silence, started = [], False, 0.0, time.time()
    block = int(SR*0.1)
    with sd.InputStream(samplerate=SR, channels=1, dtype='int16', blocksize=block) as stream:
        while time.time()-started < max_s:
            data,_ = stream.read(block); chunk = data[:,0]
            level = rms(chunk)
            if level > WAKE_RMS:
                speaking = True; silence = 0.0; frames.append(chunk)
            elif speaking:
                silence += 0.1; frames.append(chunk)
                if silence >= SILENCE_HANG: break
    if not frames: return None
    return np.concatenate(frames)

def transcribe(audio):
    if audio is None or len(audio) < SR*0.3: return ""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = f.name
    with wave.open(wav,'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(audio.tobytes())
    try:
        out = subprocess.run([WHISPER_BIN,"-m",WHISPER_MODEL,"-f",wav,"-nt","-otxt","-of",wav],
                             capture_output=True, text=True, timeout=30)
        txt = open(wav+".txt").read().strip() if os.path.exists(wav+".txt") else out.stdout.strip()
    except Exception as e:
        txt = ""
    for p in (wav, wav+".txt"):
        try: os.remove(p)
        except: pass
    return txt.strip()

CONVERSATION = "voice"

def read_reply(lines):
    """One /chat reply from its event stream: (text, stays_here, turn_id).
    `stays_here` and `turn_id` are what the last `meta` event that spoke of them
    said: each brain asked in a turn says it for itself, and the last one asked
    is the one whose text this is. A reply stays here until the server says it
    may go out: with no such event (an older server) it is spoken on this Mac."""
    text, here, turn = "", True, None
    for raw in lines:
        l = (raw.decode() if isinstance(raw, bytes) else raw).strip()
        if not l.startswith("data:"): continue
        try: e = json.loads(l[5:])
        except ValueError: continue
        if not isinstance(e, dict): continue
        if e.get("type") == "text": text += e.get("delta", "")
        elif e.get("type") == "meta" and isinstance(e.get("staysHere"), bool):
            here = e["staysHere"]
            turn = e.get("turn") if isinstance(e.get("turn"), str) else None
    return text.strip(), here, turn

def ask_flint(msg):
    body = json.dumps({"conversationId":CONVERSATION,"message":msg}).encode()
    req = urllib.request.Request(FLINT_URL+"/chat", data=body,
        headers={"authorization":"Bearer "+FLINT_TOKEN,"content-type":"application/json"})
    return read_reply(urllib.request.urlopen(req, timeout=90))

def say_here(text):
    """This Mac's own voice: nothing leaves the machine."""
    subprocess.run(["say","-v","Daniel", text[:400]])

def speak(text, here=False, turn=None):
    """Speak a reply. One that stays on this Mac (`here`) is never sent to
    /speak. Any other is, naming its conversation and turn; if the server
    refuses or fails, this Mac's own voice speaks it."""
    if here:
        say_here(text); return
    said = {"text":text, "conversationId":CONVERSATION}
    if turn: said["turnId"] = turn
    req = urllib.request.Request(FLINT_URL+"/speak", data=json.dumps(said).encode(),
        headers={"authorization":"Bearer "+FLINT_TOKEN,"content-type":"application/json"})
    try:
        data = urllib.request.urlopen(req, timeout=60).read()
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            f.write(data); mp3=f.name
        subprocess.run(["afplay", mp3]); os.remove(mp3)
    except Exception:
        say_here(text)   # fallback voice

def strip_wake(text):
    low = text.lower()
    for w in WAKE_WORDS:
        i = low.find(w)
        if i != -1:
            return True, text[i+len(w):].strip(" ,.-")
    return False, ""

def main():
    if sd is None: sys.exit("voice_client needs sounddevice and numpy: pip install sounddevice numpy")
    print(f"Hey-Flint listening… (wake words: {WAKE_WORDS})", flush=True)
    while True:
        heard = transcribe(record_utterance())
        if not heard: continue
        woke, tail = strip_wake(heard)
        if not woke: continue
        cmd = tail
        if not cmd:                       # said only the wake word -> capture the next utterance
            speak("Yeah?")
            cmd = transcribe(record_utterance())
        if not cmd: continue
        print("you:", cmd, flush=True)
        try:
            reply, here, turn = ask_flint(cmd)
        except Exception as e:
            reply, here, turn = "I couldn't reach my server.", False, None
        print("flint:", reply[:120], flush=True)
        if reply: speak(reply, here, turn)

if __name__ == "__main__":
    main()
