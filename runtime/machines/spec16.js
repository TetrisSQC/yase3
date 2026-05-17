/**
 * ZX Spectrum 16K — original 1982 entry-level model.
 *
 * Same hardware as the 48K but with only 16 KB of RAM (page 5 only).
 * Reads from 0x8000-0xFFFF return open-bus (we pre-fill a dedicated slot
 * with 0xFF at machine-select time). Writes to that range are discarded
 * into the ROM-write sink (slot 69).
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const spec16 = {
    id: 16,
    name: 'ZX Spectrum 16K',
    snapshotId: 0,

    romPages: [
        { wasmPage: 64, file: '48.rom', size: 16384 },
    ],
    ramPageCount: 1,

    frameTstates: 69888,
    firstScreenTstate: 14335,
    scanlineTstates: 224,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [5],

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

    /* readMap[2] and [3] point at slot 87 = "open bus" 0xff page (filled
       by machineSelect.js for 16K). writeMap routes those banks to the
       ROM-write sink so stray pokes vanish. */
    resetState: {
        readMap: [64, 5, 87, 87],
        writeMap: [69, 5, 69, 69],
        pagingLocked: true,
        screenPage: 5,
    },

    /* Flag read by machineSelect.js to pre-fill slot 87 with 0xff. */
    openBusSlot: 87,

    tapeLoaders: {
        default: 'tapeloaders/tape_48.szx',
        usr0: 'tapeloaders/tape_48.szx',
    },
};
