# Soundboard — Desktop App for Discord + Voicemeeter

## Prerequisites

1. **Node.js** — https://nodejs.org (LTS) — needed once to build
2. **Voicemeeter Banana** — https://vb-audio.com/Voicemeeter/banana.htm — restart after installing

## Voicemeeter setup
- Hardware Input 1 → your real mic
- Hardware Out A1 → your headphones
- Discord Input Device → Voicemeeter Output

## Build the installer (one time)
```
npm install
npm run dist
```
Opens `dist/Soundboard Setup.exe` — install it, then you're done. No terminal needed ever again.

## How to use
- App auto-detects and selects Voicemeeter Input for you
- Set Monitor → your headphones
- Add sounds, click to play, right-click for hotkeys/rename

## Signal flow
Your mic → Voicemeeter Input 1 ─┐
Soundboard → Voicemeeter Input  ├→ Discord hears both
                                └→ Your headphones
