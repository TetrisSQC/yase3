/**
 * Pentagon 512 (Pentagon 128 + extra RAM via 0x7ffd bit-6/7 extension).
 *
 * RAM page = (last_7ffd & 0x07) | ((last_7ffd & 0xC0) >> 3) — covers pages
 * 0..31. Otherwise identical to Pentagon 128 (no contention, Beta128
 * built-in, AY-3-8912 fitted, 71680 tstates/frame).
 *
 * Ships with the original Pentagon ROMs (pentagon-0.rom + 128-1.rom) and
 * TR-DOS for the Beta128.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const pentagon512 = {
    id: 10,                    // ZXST machine-ID byte.
    name: 'Pentagon 512',
    snapshotId: 10,

    romPages: [
        { wasmPage: 67, file: 'pentagon-0.rom', size: 16384 },
        { wasmPage: 66, file: '128-1.rom',     size: 16384 },
        { wasmPage: 68, file: 'trdos.rom',     size: 16384 },
    ],
    ramPageCount: 32,

    frameTstates: 71680,
    firstScreenTstate: 17988,
    scanlineTstates: 224,
    borderTimeMask: 0xff,
    contentionPattern: 'none',
    contendedPages: [],

    pagingMode: 'pentagon512',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0x8002, match: 0x0000, role: 'paging1' },
        { mask: 0xc002, match: 0xc000, role: 'aySelect' },
        { mask: 0xc002, match: 0x8000, role: 'ayData' },
        { mask: 0x00e0, match: 0x0000, role: 'kempston' },
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
