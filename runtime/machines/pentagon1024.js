/**
 * Pentagon 1024 (1 MiB RAM clone).
 *
 * Two memory ports:
 *   0x7ffd  — primary paging (last_byte). page = b & 7 + extras from bits
 *             5/6/7 unless v2.2 mode is active.
 *   0xeff7  — v2.2 register (last_byte2). bit 0 = 16-color mode (display
 *             chunky), bit 2 = enable v2.2 paging restrictions, bit 3 =
 *             "RAM at $0000" mode (page 0 is RAM, not ROM).
 *
 * 64 RAM pages, no contention, AY fitted, Beta128 built-in.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const pentagon1024 = {
    id: 11,
    name: 'Pentagon 1024',
    snapshotId: 11,

    romPages: [
        { wasmPage: 67, file: 'pentagon-0.rom', size: 16384 },
        { wasmPage: 66, file: '128-1.rom',     size: 16384 },
        { wasmPage: 68, file: 'trdos.rom',     size: 16384 },
    ],
    ramPageCount: 64,

    frameTstates: 71680,
    firstScreenTstate: 17988,
    scanlineTstates: 224,
    borderTimeMask: 0xff,
    contentionPattern: 'none',
    contendedPages: [],

    pagingMode: 'pentagon1024',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },
        { mask: 0xf008, match: 0xe000, role: 'paging2' },   // 0xeff7-class
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
