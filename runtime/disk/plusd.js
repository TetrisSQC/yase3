/*
 * Miles Gordon Technology +D disk interface.
 *
 * Ported from Fuse 1.8.0 peripherals/disk/plusd.c.
 *
 * Hardware:
 *   - 8 KB ROM at 0x0000-0x1fff (overlays system ROM when paged in)
 *   - 8 KB RAM at 0x2000-0x3fff (alongside ROM via /ROMCS)
 *   - WD1770 FDC, up to 2 drives
 *   - Centronics parallel port (stubbed)
 *
 * Port decoding (mask 0x00ff):
 *   0xe3  WD1770 status / command
 *   0xeb  WD1770 track register
 *   0xf3  WD1770 sector register
 *   0xfb  WD1770 data register
 *   0xe7  patch port: read pages +D in, write pages it out
 *   0xef  control: bits 0-1 drive sel, bit 6 printer strobe, bit 7 side
 *   0xf7  printer (read = busy, stubbed not-busy)
 *
 * jsspeccy's wasm core pages memory in 16K banks. +D pages ROM + RAM into
 * the bottom 16K (0x0000-0x3fff) — we synthesise a single 16K slot
 * (ROM_low | RAM_high) and point both read/write maps at it on page-in.
 * Wild writes to the ROM half are clobbered (real hardware ROM is r/o);
 * we restore ROM bytes on every page-in to keep state sane.
 */

import { WdFdc } from './wdFdc.js';

const ROM_SIZE = 0x2000;   // 8 KB
const RAM_SIZE = 0x2000;
const PLUSD_SLOT = 80;     // wasm machineMemory page for combined ROM+RAM

export function createPlusD({ core, memoryData, getMachineDef, romBytes }) {
    const fdc = new WdFdc({ numDrives: 2 });
    const ram = new Uint8Array(RAM_SIZE);
    let paged = false;
    let controlReg = 0;

    const combinedSlotBase = () => core.MACHINE_MEMORY + PLUSD_SLOT * 0x4000;

    /* Write ROM bytes into slot low 8K; RAM bytes into slot high 8K. */
    function syncSlotToCache() {
        memoryData.set(romBytes.subarray(0, ROM_SIZE), combinedSlotBase());
        memoryData.set(ram, combinedSlotBase() + ROM_SIZE);
    }
    /* After Z80 writes (which go through slot bytes directly), pull RAM
       half back into the JS cache so we keep an authoritative copy that
       survives bank switches. */
    function syncCacheFromSlot() {
        ram.set(
            memoryData.subarray(combinedSlotBase() + ROM_SIZE,
                                combinedSlotBase() + ROM_SIZE + RAM_SIZE));
    }

    function pageIn() {
        if (paged) return;
        syncCacheFromSlot();  // capture any RAM written via stock map (safety)
        syncSlotToCache();    // refresh ROM bytes in case wild writes clobbered them
        memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = PLUSD_SLOT;
        memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = PLUSD_SLOT;
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

    function applyControl(b) {
        controlReg = b;
        const driveBits = b & 0x03;
        const drive = driveBits === 2 ? 1 : 0;
        const side = (b & 0x80) ? 1 : 0;
        fdc.selectDrive(drive);
        fdc.selectSide(side);
    }

    return {
        type: 'plusd',
        fdc,
        ports: [
            // WD1770 command/status — port 0xe3
            { mask: 0x00ff, match: 0x00e3,
              read:  () => fdc.readStatus(),
              write: (_p, v) => fdc.writeCommand(v) },
            // Track register — port 0xeb
            { mask: 0x00ff, match: 0x00eb,
              read:  () => fdc.readTrack(),
              write: (_p, v) => fdc.writeTrack(v) },
            // Sector register — port 0xf3
            { mask: 0x00ff, match: 0x00f3,
              read:  () => fdc.readSector(),
              write: (_p, v) => fdc.writeSector(v) },
            // Data register — port 0xfb
            { mask: 0x00ff, match: 0x00fb,
              read:  () => fdc.readData(),
              write: (_p, v) => fdc.writeData(v) },
            // Patch port — read pages in, write pages out (port 0xe7)
            { mask: 0x00ff, match: 0x00e7,
              read:  () => { pageIn(); return 0; },
              write: () => { pageOut(); } },
            // Control register — port 0xef
            { mask: 0x00ff, match: 0x00ef,
              write: (_p, v) => applyControl(v) },
            // Printer — port 0xf7 (stub: never busy when no printer)
            { mask: 0x00ff, match: 0x00f7,
              read:  () => 0x7f,
              write: () => {} },
        ],
        insert: (drv, disk) => fdc.insert(drv, disk),
        eject:  (drv)       => fdc.eject(drv),
        isPaged: () => paged,
        pageOut,                          // exposed for hard-reset / detach
        reset() {
            ram.fill(0);
            paged = false;
            controlReg = 0;
            fdc.writeCommand(0xd0);       // force interrupt — clear busy
            for (const d of fdc.drives) d.track = 0;
            syncSlotToCache();
        },
    };
}
