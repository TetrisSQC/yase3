/**
 * ZX Spectrum 48K.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const spec48 = {
    id: 48,
    name: 'ZX Spectrum 48K',
    snapshotId: 1,

    romPages: [
        { wasmPage: 64, file: '48.rom', size: 16384 },
    ],
    ramPageCount: 3,

    frameTstates: 69888,
    firstScreenTstate: 14335,
    scanlineTstates: 224,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [1, 3, 5, 7],

    pagingMode: 'none',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0x00e0, match: 0x0000, role: 'kempston' },
    ],
    screenPages: [5],
    timex: false,
    ay: 'none',

    periph: [
        { type: 'ula' },
        { type: 'kempston' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [64, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: true,
        screenPage: 5,
    },

    tapeLoaders: {
        default: 'tapeloaders/tape_48.szx',
        usr0: 'tapeloaders/tape_48.szx',
    },
};
