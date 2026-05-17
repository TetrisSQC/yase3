/**
 * Pentagon 128.
 *
 * 128K Spectrum clone with no ULA contention, Beta128 disk interface, and
 * Pentagon timing (71680 tstates/frame).
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const pentagon128 = {
    id: 5,
    name: 'Pentagon 128',
    snapshotId: 7,

    romPages: [
        { wasmPage: 67, file: 'pentagon-0.rom', size: 16384 },
        { wasmPage: 66, file: '128-1.rom',     size: 16384 },
        { wasmPage: 68, file: 'trdos.rom',     size: 16384 },
    ],
    ramPageCount: 8,

    frameTstates: 71680,
    firstScreenTstate: 17988,
    scanlineTstates: 224,
    borderTimeMask: 0xff,            // no contention window
    contentionPattern: 'none',
    contendedPages: [],

    pagingMode: 'pentagon128',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },
        { mask: 0xc002, match: 0xc000, role: 'aySelect' },
        { mask: 0xc002, match: 0x8000, role: 'ayData' },
        { mask: 0x00e0, match: 0x0000, role: 'kempston' },
        // Beta128 ports 0x1f/0x3f/0x5f/0x7f/0xff: handled in periph bus
    ],
    screenPages: [5, 7],
    timex: false,
    ay: 'sinclair',

    periph: [
        { type: 'ula' },
        { type: 'ay' },
        { type: 'kempston' },
        { type: 'beta128' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [67, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },

    tapeLoaders: {
        default: 'tapeloaders/tape_pentagon.szx',
        usr0: 'tapeloaders/tape_pentagon_usr0.szx',
    },
};
