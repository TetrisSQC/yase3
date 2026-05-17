/*
 * +3 / +2A internal floppy controller (UPD765A) at ports 0x2ffd / 0x3ffd.
 *
 *   0x2ffd  status register (UPD765 MSR)        — read-only
 *   0x3ffd  data register                       — read/write
 *
 * Mask 0xf002 / match 0x2000 covers the 0x2ffd family (A14=1, A13=0, A12=1,
 * A1=0). 0x3000 covers 0x3ffd. The +3 BIOS uses these strict bits.
 */

import { UpdFdc } from './updFdc.js';

export function createPlus3Fdc() {
    const fdc = new UpdFdc({ numDrives: 2 });

    return {
        type: 'upd765',
        fdc,
        ports: [
            {
                mask: 0xf002, match: 0x2000,
                read:  () => fdc.readStatus(),
                write: () => { /* status port is read-only */ },
            },
            {
                mask: 0xf002, match: 0x3000,
                read:  () => fdc.readData(),
                write: (port, val) => fdc.writeData(val),
            },
        ],
        insert: (drv, disk) => fdc.insert(drv, disk),
        eject:  (drv)       => fdc.eject(drv),
        reset() {
            fdc.cmdBuf = [];
            fdc.phase = 'cmd';
            fdc.msr = 0x80;  // RQM only
        },
    };
}
