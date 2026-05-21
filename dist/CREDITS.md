# YaSE — Credits & Attribution

YaSE (Yet another Spectrum Emulator) is a fork of JSSpeccy 3 with
substantial additions ported from Fuse and original work.

Licensed under the GNU General Public License v3 (see `COPYING`).

---

## Upstream

### JSSpeccy 3
- Copyright © Matt Westcott
- Repository: https://github.com/gasman/jsspeccy3
- License: GPL v3
- Provided: the base Z80 core (AssemblyScript / wasm), framebuffer
  rendering, audio, host UI scaffolding, tape parsers (TAP/TZX),
  snapshot parsers (Z80/SZX/SNA), Beta128 + +3 FDC peripherals.

### Fuse — The Free Unix Spectrum Emulator
- Copyright © Philip Kendall, Stuart Brady, Fredrick Meunier, Gergely
  Szasz, Dmitry Sanarin, Darren Salt, and many others.
- Project: http://fuse-emulator.sourceforge.net/
- License: GPL v2 or (at your option) any later version.
- The following YaSE source files are JavaScript ports of Fuse 1.8.0 C
  source (cited in each file's header comment) and are therefore
  derivative works under GPL v2+:
  - `runtime/disk/plusd.js`       ← `peripherals/disk/plusd.c`
  - `runtime/disk/disciple.js`    ← `peripherals/disk/disciple.c`
  - `runtime/disk/didaktik.js`    ← `peripherals/disk/didaktik.c`
  - `runtime/peripherals/multiface.js`  ← `peripherals/multiface.c`
  - `runtime/peripherals/interface1.js` ← `peripherals/if1.c`
  - `runtime/disk/dck.js`         ← `peripherals/dck.c` (format spec)
  - The SCLD memory-paging behaviour in `generator/core.ts.in`,
    Scorpion paging fixes, and the Timex ULA port-decode rule were
    derived from reading Fuse's machine source.

---

## YaSE original contributions

The following components are original to YaSE and not part of either
JSSpeccy 3 or Fuse:

- **WebGL CRT pixel shader** (`runtime/crt.js`) — scanlines, vignette,
  distortion, flicker, pixel shift, aspect-ratio constraint.
- **Touch joystick overlay** (`runtime/touchControls.js`) — transparent
  D-pad + A/B buttons with pointer-event multi-touch.
- **On-screen ZX keyboard overlay** (`runtime/zxKeyboard.js`) — image-
  backed hit-zone grid, auto-show in portrait orientation.
- **Pokefinder** (`runtime/osd/widgets/pokefinder.js`,
  `runtime/worker.js`) — value-search cheat tool.
- **RZX recording & playback** (`runtime/rzx.js`, wasm hooks,
  worker bridge) — RZX 0.13 writer/reader, per-frame input capture.
- **Debugger widget** (`runtime/osd/widgets/debugger.js`,
  `runtime/debugger/disasm.js`) — register dump, Z80 disassembler,
  breakpoint bitmap, step / step-over.
- **Memory viewer** (`runtime/osd/widgets/memory.js`) — hex+ASCII dump
  with cursor, goto, byte edit.
- **Z80 snapshot writer** (`runtime/snapshotExport.js`) — v3 emitter.
- **Interface 2 cartridge slot** (worker integration, menu, wasm
  reset-map override).
- **Tape save trap → .tap writer** (worker, SA-BYTES trap).
- **PWA / offline support** (`static/manifest.webmanifest`,
  `static/service-worker.js`, manifest registration in index.html).
- **Spectrum 16K machine variant** (`runtime/machines/spec16.js`).
- **AI-assisted code generation**: large portions of the YaSE additions
  and Fuse-port work above were drafted with the help of Anthropic
  Claude (Sonnet / Opus 4.x) during interactive sessions. Final review,
  integration and bug fixes by the project maintainer.

---

## Bitmap font

The OSD bitmap font (`runtime/osd/render.js`) is read from offset
`0x3D00` of the 48K Spectrum ROM at runtime. The 48K ROM is
**copyrighted Amstrad plc** but freely redistributable for emulation
purposes per Amstrad's long-standing permission grant.

## Other ROMs

System ROMs shipped under `static/roms/` (48, 128, +2, +3, +3e, Pentagon,
TC2048, TC2068, SE, +D, DISCiPLE, TR-DOS) are redistributable under
Amstrad's emulation grant or their respective community licences.

ROMs **not** included (must be supplied separately):
- Scorpion ZS 256 (`scorpion-0..3.rom`)
- Didaktik D80 (`didaktik80.rom`)
- Opus Discovery (`opus.rom`)
- Multiface One / 128 / 3 (`mf1.rom`, `mf128.rom`, `mf3.rom`)
- Interface 1 (`if1-2.rom`)

Place them under `static/roms/` and rebuild.

---

## Reporting

If you believe an attribution is missing or incorrect, please open
an issue.
