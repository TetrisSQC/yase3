/**
 * Spectrum SE — community 128K + Timex SCLD hybrid.
 *
 * 128K-style paging via full-decoded port 0x7ffd (mask 0xffff) plus a Timex
 * SCLD with dock/exrom overlay. Two ROMs (se-0.rom + se-1.rom) used like a
 * regular 128K.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const specSe = {
    id: 8,
    name: 'Spectrum SE',
    snapshotId: 8,

    romPages: [
        { wasmPage: 65, file: 'se-0.rom', size: 16384 },
        { wasmPage: 66, file: 'se-1.rom', size: 16384 },
    ],
    ramPageCount: 8,

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [1, 3, 5, 7],

    pagingMode: 'se',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xffff, match: 0x7ffd, role: 'paging1' },   // full decode
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
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [65, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },
};
