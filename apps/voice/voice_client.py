#!/usr/bin/env python3
"""Hey-Flint voice assistant — hands-free, always-listening (like Alexa).
Runs on the Mac Studio next to Flint. Flow: listen -> hear the wake word
("flint"/"hey flint") -> capture your command -> send to Flint -> speak the reply
in his onyx voice. Reuses whisper-cli (STT) + Flint's /speak (TTS); no cloud
wake-word service.

Deps:  pip install sounddevice numpy   (whisper-cli + afplay already on macOS)
Run:   python3 voice_client.py          (tune WAKE_RMS on real hardware)
Env:   FLINT_URL, FLINT_TOKEN, WAKE_WORDS, WHISPER_BIN, WHISPER_MODEL
"""
import os, sys, json, subprocess, tempfile, time, urllib.request, wave
import numpy as np
import sounddevice as sd

FLINT_URL   = os.environ.get("FLINT_URL", "http://127.0.0.1:8080")
FLINT_TOKEN = os.environ.get("FLINT_TOKEN") or subprocess.check_output(
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

def ask_flint(msg):
    body = json.dumps({"conversationId":"voice","message":msg}).encode()
    req = urllib.request.Request(FLINT_URL+"/chat", data=body,
        headers={"authorization":"Bearer "+FLINT_TOKEN,"content-type":"application/json"})
    t=""
    for raw in urllib.request.urlopen(req, timeout=90):
        l=raw.decode().strip()
        if l.startswith("data:"):
            e=json.loads(l[5:])
            if e.get("type")=="text": t+=e.get("delta","")
    return t.strip()

def speak(text):
    body = json.dumps({"text":text}).encode()
    req = urllib.request.Request(FLINT_URL+"/speak", data=body,
        headers={"authorization":"Bearer "+FLINT_TOKEN,"content-type":"application/json"})
    try:
        data = urllib.request.urlopen(req, timeout=60).read()
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            f.write(data); mp3=f.name
        subprocess.run(["afplay", mp3]); os.remove(mp3)
    except Exception:
        subprocess.run(["say","-v","Daniel", text[:400]])   # fallback voice

def strip_wake(text):
    low = text.lower()
    for w in WAKE_WORDS:
        i = low.find(w)
        if i != -1:
            return True, text[i+len(w):].strip(" ,.-")
    return False, ""

def main():
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
            reply = ask_flint(cmd)
        except Exception as e:
            reply = "I couldn't reach my server."
        print("flint:", reply[:120], flush=True)
        if reply: speak(reply)

if __name__ == "__main__":
    main()
