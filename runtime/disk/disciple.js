/*
 * Rockfort Products DISCiPLE disk + network + printer interface.
 *
 * Ported from Fuse 1.8.0 peripherals/disk/disciple.c.
 *
 * Hardware (same family as +D):
 *   - 8 KB ROM + 8 KB RAM overlay via /ROMCS at 0x0000-0x3fff
 *   - WD1770 FDC, up to 2 drives
 *   - "memswap" flag (port 0x7b) flips ROM ↔ RAM in the 8K halves:
 *       memswap=0 → ROM low (0x0000), RAM high (0x2000)
 *       memswap=1 → RAM low (0x0000), ROM high (0x2000)
 *   - Kempston-compatible joystick port — but on DISCiPLE port 0x1f returns
 *     printer-busy on bit 6 (not joystick) and is written for drive/side/
 *     printer-strobe/inhibit control.
 *
 * Port decoding (mask 0x00ff):
 *   0x1b  WD1770 status / command
 *   0x5b  WD1770 track register
 *   0x9b  WD1770 sector register
 *   0xdb  WD1770 data register
 *   0x1f  read=joystick/printer-busy, write=control (drive/side/strobe/inhibit)
 *   0x3b  write=network (stub)
 *   0x7b  read pages in, sets memswap=0; write pages out, sets memswap=1
 *   0xbb  read pages in;  write pages out
 *   0xfb  write=printer (stub)
 *
 * 16K-granularity caveat (same as +D): wasm core pages memory in 16K banks.
 * We synthesise a single 16K slot (ROM low + RAM high, or swapped when
 * memswap is set) and point both read/write maps at it on page-in.
 */

import { WdFdc } from './wdFdc.js';

const ROM_SIZE = 0x2000;
const RAM_SIZE = 0x2000;
const DISCIPLE_SLOT = 83;     // wasm machineMemory page for combined ROM+RAM

export function createDISCiPLE({ core, memoryData, getMachineDef, romBytes }) {
    const fdc = new WdFdc({ numDrives: 2 });
    const ram = new Uint8Array(RAM_SIZE);
    let paged = false;
    let memswap = 0;      // 0 = ROM low, 1 = ROM high
    let controlReg = 0;

    const slotBase = () => core.MACHINE_MEMORY + DISCIPLE_SLOT * 0x4000;

    /* Repaint the 16K combined slot based on current memswap state. */
    function syncSlotToCache() {
        const base = slotBase();
        const rom = romBytes.subarray(0, ROM_SIZE);
        if (memswap === 0) {
            memoryData.set(rom, base);
            memoryData.set(ram, base + ROM_SIZE);
        } else {
            memoryData.set(ram, base);
            memoryData.set(rom, base + ROM_SIZE);
        }
    }

    /* Pull the RAM half of the slot back into our JS cache; called before any
       state change that would overwrite slot bytes so writes survive. */
    function syncCacheFromSlot() {
        const base = slotBase();
        if (memswap === 0) {
            ram.set(memoryData.subarray(base + ROM_SIZE, base + ROM_SIZE + RAM_SIZE));
        } else {
            ram.set(memoryData.subarray(base, base + RAM_SIZE));
        }
    }

    function pageIn() {
        if (paged) return;
        syncCacheFromSlot();
        syncSlotToCache();
        memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = DISCIPLE_SLOT;
        memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = DISCIPLE_SLOT;
        paged = true;
    }

    function pageOut() {
        if (!paged) return;
        syncCacheFromSlot();
        const def = getMachineDef();
        if (def) {
            memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = def.resetState.readMap[0];
            memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = def.resetState.writeMap[0];
        }
        paged = false;
    }

    function setMemswap(v) {
        if (v === memswap) return;
        // Capture any pending RAM bytes under the current layout, then
        // re-emit with the new layout.
        if (paged) syncCacheFromSlot();
        memswap = v;
        if (paged) syncSlotToCache();
    }

    function applyControl(b) {
        controlReg = b;
        // DISCiPLE: bit 0 selects drive (inverted), bit 1 selects side.
        const drive = (b & 0x01) ? 0 : 1;
        const side  = (b & 0x02) ? 1 : 0;
        fdc.selectDrive(drive);
        fdc.selectSide(side);
        // bit 6 = printer strobe (not emulated)
        // bit 4 = inhibit (not emulated)
    }

    return {
        type: 'disciple',
        fdc,
        ports: [
            // WD1770 ports
            { mask: 0x00ff, match: 0x001b,
              read:  () => fdc.readStatus(),
              write: (_p, v) => fdc.writeCommand(v) },
            { mask: 0x00ff, match: 0x005b,
              read:  () => fdc.readTrack(),
              write: (_p, v) => fdc.writeTrack(v) },
            { mask: 0x00ff, match: 0x009b,
              read:  () => fdc.readSector(),
              write: (_p, v) => fdc.writeSector(v) },
            { mask: 0x00ff, match: 0x00db,
              read:  () => fdc.readData(),
              write: (_p, v) => fdc.writeData(v) },
            // Control + joystick/printer-status read at 0x1f
            { mask: 0x00ff, match: 0x001f,
              read:  () => 0xbf,                    // no printer attached → bit 6 = busy
              write: (_p, v) => applyControl(v) },
            // Network port (stub)
            { mask: 0x00ff, match: 0x003b,
              write: () => {} },
            // Boot/memswap port 0x7b
            { mask: 0x00ff, match: 0x007b,
              read:  () => { setMemswap(0); return 0; },
              write: () => { setMemswap(1); } },
            // Patch port 0xbb — page in/out
            { mask: 0x00ff, match: 0x00bb,
              read:  () => { pageIn(); return 0; },
              write: () => { pageOut(); } },
            // Printer port (stub)
            { mask: 0x00ff, match: 0x00fb,
              write: () => {} },
        ],
        insert: (drv, disk) => fdc.insert(drv, disk),
        eject:  (drv)       => fdc.eject(drv),
        isPaged: () => paged,
        pageOut,
        reset() {
            ram.fill(0);
            paged = false;
            memswap = 0;
            controlReg = 0;
            fdc.writeCommand(0xd0);     // force interrupt — clear busy
            for (const d of fdc.drives) d.track = 0;
            syncSlotToCache();
        },
    };
}
