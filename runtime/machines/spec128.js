/**
 * ZX Spectrum 128K.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const spec128 = {
    id: 128,
    name: 'ZX Spectrum 128K',
    snapshotId: 2,

    romPages: [
        { wasmPage: 65, file: '128-0.rom', size: 16384 },
        { wasmPage: 66, file: '128-1.rom', size: 16384 },
    ],
    ramPageCount: 8,

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [1, 3, 5, 7],

    pagingMode: '128',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },   // 0x7ffd: !A1 & !A15
        { mask: 0xc002, match: 0xc000, role: 'aySelect' },  // 0xfffd
        { mask: 0xc002, match: 0x8000, role: 'ayData' },    // 0xbffd
        { mask: 0x00e0, match: 0x0000, role: 'kempston' },
    ],
    screenPages: [5, 7],
    timex: false,
    ay: 'sinclair',

    periph: [
        { type: 'ula' },
        { type: 'ay' },
        { type: 'kempston' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [65, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },

    tapeLoaders: {
        default: 'tapeloaders/tape_128.szx',
        usr0: 'tapeloaders/tape_128_usr0.szx',
    },
};
