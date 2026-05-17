/*
 * Didaktik D40 / D80 disk interface (8-bit, port-based).
 *
 * Ported from Fuse 1.8.0 peripherals/disk/didaktik.c.
 *
 * Hardware:
 *   - 14 KB ROM + 2 KB RAM mapped to 0x0000-0x3FFF when /ROMCS active
 *       0x0000-0x37FF  ROM (14K)
 *       0x3800-0x3FFF  RAM (2K)
 *   - WD2797 FDC (we use the shared WdFdc class which approximates WD1770)
 *   - 8255 PIA stubbed (read=0xff, writes ignored)
 *   - Aux register for drive/motor select
 *
 * Ports (mask / match):
 *   0x00ff / 0x0081   FDC status / command
 *   0x00ff / 0x0083   FDC track
 *   0x00ff / 0x0085   FDC sector
 *   0x00ff / 0x0087   FDC data
 *   0x0080 / 0x0000   8255 PIA (mask: bit 7 = 0)
 *   0x00f9 / 0x0089   Aux register write (drive/motor select)
 *
 * Paging: real Didaktik pages itself in on NMI button press (not emulated).
 * For this port we treat "enabled" as "always paged" — disk routines work
 * once user enables the interface via the menu.
 *
 * ROM file: `didaktik80.rom` (16 KB image, lower 14 KB used). Place under
 * static/roms/. Not freely redistributable.
 */

import { WdFdc } from './wdFdc.js';

const ROM_USED = 0x3800;          // 14 KB
const RAM_SIZE = 0x0800;          // 2 KB
const SLOT = 84;                  // wasm machineMemory page for combined ROM+RAM

export function createDidaktik({ core, memoryData, getMachineDef, romBytes }) {
    const fdc = new WdFdc({ numDrives: 2 });
    const ram = new Uint8Array(RAM_SIZE);
    let paged = false;
    let auxReg = 0;

    const slotBase = () => core.MACHINE_MEMORY + SLOT * 0x4000;

    function syncSlotToCache() {
        const base = slotBase();
        memoryData.set(romBytes.subarray(0, ROM_USED), base);
        memoryData.set(ram, base + ROM_USED);
        // Pad upper 2K (after RAM) with 0xff so reads in 0x3800-0x3FFF only
        // touch the RAM bytes; 0x3800-0x3FFF is the actual RAM window.
    }
    function syncCacheFromSlot() {
        const base = slotBase();
        ram.set(memoryData.subarray(base + ROM_USED, base + ROM_USED + RAM_SIZE));
    }

    function pageIn() {
        if (paged) return;
        syncSlotToCache();
        memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = SLOT;
        memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = SLOT;
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

    function applyAux(b) {
        // bit 0: drive 0 select, bit 1: drive 1 select (drive 1 wins if both)
        const drive = (b & 0x02) ? 1 : 0;
        fdc.selectDrive(drive);
        auxReg = b;
    }

    return {
        type: 'didaktik',
        fdc,
        ports: [
            { mask: 0x00ff, match: 0x0081,
              read:  () => fdc.readStatus(),
              write: (_p, v) => fdc.writeCommand(v) },
            { mask: 0x00ff, match: 0x0083,
              read:  () => fdc.readTrack(),
              write: (_p, v) => fdc.writeTrack(v) },
            { mask: 0x00ff, match: 0x0085,
              read:  () => fdc.readSector(),
              write: (_p, v) => fdc.writeSector(v) },
            { mask: 0x00ff, match: 0x0087,
              read:  () => fdc.readData(),
              write: (_p, v) => fdc.writeData(v) },
            // 8255 PIA — bit 7 = 0 ports. Stubbed: read 0xff, writes ignored.
            // Note: this matches kempston port 0x1f too; on Didaktik machines
            // it's intentional that PIA shadows kempston.
            { mask: 0x0080, match: 0x0000,
              read:  () => 0xff,
              write: () => {} },
            // Aux register at port 0x89 / 0x8b / 0x8d / 0x8f (mask 0xf9 match 0x89).
            { mask: 0x00f9, match: 0x0089,
              write: (_p, v) => applyAux(v) },
        ],
        insert: (drv, disk) => fdc.insert(drv, disk),
        eject:  (drv)       => fdc.eject(drv),
        isPaged: () => paged,
        pageOut,
        reset() {
            ram.fill(0);
            auxReg = 0;
            fdc.writeCommand(0xd0);
            for (const d of fdc.drives) d.track = 0;
            // Auto-page when reset (since real HW pages on NMI which we don't emu).
            pageIn();
        },
    };
}
