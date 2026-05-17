/*
 * MachineDef — declarative description of an emulated Spectrum machine.
 *
 * A MachineDef is plain data: no methods, no state. The worker reads it on
 * machine select and (a) writes a MachineConfig block into wasm memory,
 * (b) loads the ROM pages into the wasm core, (c) registers peripherals on
 * the bus, (d) issues reset.
 *
 * Paging modes (one-of):
 *   'none'         — 48K, no paging port.
 *   '128'          — 128K port 0x7ffd.
 *   'plus3'        — +2A/+3 dual port 0x7ffd + 0x1ffd, 4 ROMs, special RAM modes.
 *   'plus3e'       — +3e: plus3 + IDE-style ROM bank extensions.
 *   'pentagon128'  — 128K paging without contention.
 *   'pentagon512'  — Pentagon 128 + last_byte2 (port 0x7ffd bits 6:7 extension).
 *   'pentagon1024' — 64-page paging + 16-color mode flag.
 *   'scorpion'     — Port 0x1ffd extends to 16 RAM banks, locking.
 *   'se'           — Spectrum SE: 9 banks, Timex SCLD overlay.
 *   'timexScld'    — TC2048/TC2068/TS2068: SCLD port 0xff, dock/exrom 8K banks.
 *
 * Contention patterns (cycle delays applied during contended access window):
 *   'none'         — Pentagon family.
 *   '65432100'     — 48K, 128K, Timex (delay = (6-(t%8))%8 in first 7 cycles, 0 on 8th).
 *   '76543210'     — +3/+3e (CPC-style: delay = (7-(t%8))).
 *
 * AY config:
 *   'none'         — 48K, TC2048.
 *   'sinclair'     — 128K-style ports 0xfffd (sel) / 0xbffd (data), partial decode 0xc002/0x8002.
 *   'timex'        — Timex full decode 0xf5/0xf6 + register-14 joystick overlay.
 *   'fuller'       — Fuller Audio Box ports 0x3f/0x5f (peripheral, not core machine).
 *
 * Snapshot ID = ZXST machine type byte (see SZX spec); used by snapshot loaders.
 */

/**
 * @typedef {Object} RomSlot
 * @property {number} wasmPage      Wasm core ROM page index (0..15) to load into.
 * @property {string} file          Filename under static/roms/.
 * @property {number} size          Expected byte size (16384 or 8192 for TC2068 EXROM).
 */

/**
 * @typedef {Object} PortDecode
 * @property {number} mask          AND mask applied to port number.
 * @property {number} match         Value the masked port must equal.
 * @property {string} role          'paging1' | 'paging2' | 'ulaPort' | 'scld' | 'kempston' | 'aySelect' | 'ayData' | 'beta128' | ...
 */

/**
 * @typedef {Object} PeriphSpec
 * @property {string} type          Peripheral key (e.g. 'ula', 'kempston', 'beta128', 'upd765', 'scld').
 * @property {Object} [options]     Peripheral-specific config.
 */

/**
 * @typedef {Object} MachineDef
 * @property {number}   id                Public machine ID (matches existing 48/128/5 + new IDs from ZXST).
 * @property {string}   name              Human label for menu.
 * @property {number}   snapshotId        ZXST machine ID byte for SZX.
 * @property {RomSlot[]} romPages         ROM images to load and their wasm slot indices.
 * @property {number}   ramPageCount      Number of 16 KiB RAM pages (3=48K, 8=128K, 16=Scorpion, 32=P512, 64=P1024, 9=SE).
 * @property {number}   frameTstates      Tstates per frame (69888 / 70908 / 71680 / 70576 / ...).
 * @property {number}   firstScreenTstate Tstate at which first visible screen byte is fetched (14335, 14361, 17988 ...).
 * @property {number}   scanlineTstates   Tstates per scanline (224 = 48/Timex, 228 = 128).
 * @property {number}   borderTimeMask    Bitmask applied to (t & 7) when deciding contention. 0xfc = standard 48/128, 0xff = none.
 * @property {('none'|'65432100'|'76543210')} contentionPattern
 * @property {number[]} contendedPages    RAM page indices that incur contention (e.g. [1,3,5,7] on 128, [5] on 48).
 * @property {string}   pagingMode
 * @property {PortDecode[]} portDecodes   How port numbers are routed to roles (ULA, paging, kempston, aySel/Data, SCLD ...).
 * @property {number[]} screenPages       RAM pages usable as screen (e.g. [5] or [5,7]).
 * @property {boolean}  timex             Enables SCLD display logic.
 * @property {('none'|'sinclair'|'timex'|'fuller')} ay
 * @property {(port:number)=>number} [unattachedPort]  Returns value for unhandled port read; default 0xff.
 * @property {PeriphSpec[]} periph        Peripherals to register on the bus at machine select.
 * @property {string}   defaultJoystick   'none'|'kempston'|'sinclair1'|'sinclair2'|'cursor'|'timex1'|'timex2'.
 * @property {Object}   resetState        Initial paging on reset:
 *                                          { readMap:[a,b,c,d], writeMap:[a,b,c,d], pagingLocked:bool, screenPage:number }
 * @property {Object}   [tapeLoaders]     Snapshot filenames keyed by mode ('default','usr0') for the existing trap-fast-load mechanism.
 */

/* No runtime exports — this file is JSDoc only. */
export {};
