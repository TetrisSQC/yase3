/*
 * Beta128 disk interface (TR-DOS).
 *
 * Wraps a WD1770 FDC and exposes the standard Beta port map:
 *
 *   0x1f  command / status
 *   0x3f  track register
 *   0x5f  sector register
 *   0x7f  data register
 *   0xff  system register (drive select / side / motor / halt)
 *
 * The wasm core handles the TR-DOS ROM swap-in trap (PC enters $3Dxx with
 * the regular ROM mapped). This wrapper only handles the FDC I/O — the
 * wasm bits stay as they are.
 */

import { WdFdc } from './wdFdc.js';

export function createBeta128() {
    const fdc = new WdFdc({ numDrives: 4 });
    let systemReg = 0;

    function applySystemReg(val) {
        // Bits per Beta spec:
        //   0..1  drive select (0..3)
        //   2     not-reset (active low). 0 = reset.
        //   3     block hlt (halts the Z80 — not emulated).
        //   4     side select (0 = side 0, 1 = side 1)
        //   6     density (1 = double-density / MFM)
        systemReg = val;
        fdc.selectDrive(val & 0x03);
        fdc.selectSide((val >> 4) & 1);
    }

    return {
        type: 'beta128',
        fdc,
        ports: [
            {
                mask: 0x00ff, match: 0x001f,
                read:  () => fdc.readStatus(),
                write: (port, val) => fdc.writeCommand(val),
            },
            {
                mask: 0x00ff, match: 0x003f,
                read:  () => fdc.readTrack(),
                write: (port, val) => fdc.writeTrack(val),
            },
            {
                mask: 0x00ff, match: 0x005f,
                read:  () => fdc.readSector(),
                write: (port, val) => fdc.writeSector(val),
            },
            {
                mask: 0x00ff, match: 0x007f,
                read:  () => fdc.readData(),
                write: (port, val) => fdc.writeData(val),
            },
            {
                mask: 0x00ff, match: 0x00ff,
                read:  () => 0x80 | (fdc.readStatus() & 0x40),  // INTRQ at bit 7, DRQ at bit 6
                write: (port, val) => applySystemReg(val),
            },
        ],
        insert: (drv, disk) => fdc.insert(drv, disk),
        eject:  (drv)       => fdc.eject(drv),
        reset() {
            systemReg = 0;
            for (let i = 0; i < 4; i++) fdc.drives[i].track = 0;
            fdc.writeCommand(0xd0);
        },
    };
}
