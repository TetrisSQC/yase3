/**
 * Timex TC2068.
 *
 * 48K + SCLD + AY-3-8912 + 8K cartridge dock ROM (slot 79). The Timex
 * AY uses non-standard port addresses (full decode 0xf5/0xf6) and overlays
 * the joystick bits via register-14 reads.
 *
 * Dock cartridge ROM is shipped as tc2068-1.rom (8 KiB) — used when the
 * SCLD HSR routes the $0000-$1fff window to the dock. Full 8K dock paging
 * is deferred; reset state maps slot 0 to the 16K system ROM (tc2068-0.rom).
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const tc2068 = {
    id: 17,
    name: 'Timex TC2068',
    snapshotId: 15,

    romPages: [
        { wasmPage: 64, file: 'tc2068-0.rom', size: 16384 },
        { wasmPage: 79, file: 'tc2068-1.rom', size: 8192 },
    ],
    ramPageCount: 3,

    frameTstates: 69888,
    firstScreenTstate: 14335,
    scanlineTstates: 224,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [5],

    pagingMode: 'timexScld',
    portDecodes: [
        { mask: 0x00ff, match: 0x00fe, role: 'ulaPort' },
        { mask: 0x00ff, match: 0x00ff, role: 'scld' },
        { mask: 0x00ff, match: 0x00f4, role: 'scldHsr' },
        { mask: 0x00ff, match: 0x00f5, role: 'aySelect' },
        { mask: 0x00ff, match: 0x00f6, role: 'ayData' },
    ],
    screenPages: [5, 7],
    timex: true,
    ay: 'timex',

    periph: [
        { type: 'ula' },
        { type: 'ay' },
        { type: 'scld' },
    ],
    defaultJoystick: 'timex1',

    resetState: {
        readMap: [64, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: true,
        screenPage: 5,
    },
};
