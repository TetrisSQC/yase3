/**
 * Timex TS2068 (US TC2068 variant).
 *
 * Same hardware as TC2068; uses the US system ROM. The dock cartridge ROM
 * is identical in form.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const ts2068 = {
    id: 13,
    name: 'Timex TS2068',
    snapshotId: 13,

    romPages: [
        // TS2068 uses the same ROM image as TC2068 in common distributions.
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
