# Hey-Flint — hands-free voice ("like Alexa")

Always-listening wake-word assistant that runs on the Mac Studio beside Flint.
Say **"Hey Flint"**, ask, and he answers out loud in his onyx voice.

## How it works
`voice_client.py`: listens on the mic → on the wake word ("hey flint" / "flint")
captures your command → whisper-cli transcribes it → sends to Flint's `/chat` →
plays the reply through `/speak` (onyx). No cloud wake-word service; reuses the
STT/TTS Flint already has.

`/speak` is an outside speech service (OpenAI) unless Flint is set to speak on this Mac
(`FLINT_TTS_PROVIDER`, see "Voice" in `apps/server/README.md`). A reply Flint marks as staying
on this Mac (a private turn, a turn taken in Local mode, a turn answered with Will's goals, or
one that read such a turn: the chat stream's `meta` event says so) is never sent to an outside
service. The client speaks it with the Mac's own `say` voice. It is sent to `/speak` only when
that same event says the server's speech is made on this Mac (`speechHere`). Every other
reply's request names its conversation and turn, so the server can refuse on its side too, and
a refusal falls back to `say`. The audio is played as the kind the server says it is (mp3 from
OpenAI, m4a from the Mac's own voice, whatever a local speech server sends).

## Install on the Mac Studio
```
pip3 install sounddevice numpy
mkdir -p ~/.flint/voice && cp voice_client.py ~/.flint/voice/
cp com.flint.voice.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flint.voice.plist
```
Grant **Microphone** access to the runner (System Settings → Privacy & Security →
Microphone). Plug in a USB mic or use the Studio's; add a small speaker for output.

## Tuning (on real hardware)
- `WAKE_RMS` — speech-vs-silence threshold; raise if it triggers on noise, lower
  if it misses you.
- `WAKE_WORDS` — comma list (default "hey flint,flint,okay flint").
- For rock-solid wake detection later, swap in a dedicated wake-word engine
  (openWakeWord, local & free) — this MVP uses whisper keyword-spotting, which is
  simple and works but is less precise in noisy rooms.

MVP built 2026 — ready to run + tune once the Studio and a mic are set up.
