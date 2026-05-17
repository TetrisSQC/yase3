/**
 * ZX Spectrum +2A (black case, +3-style paging, no FDC).
 *
 * Functionally a +3 minus the internal floppy disk controller. Uses the same
 * 4-ROM bank set as +3. CPC-style contention pattern (76543210) on pages
 * 4..7.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const specplus2a = {
    id: 4,
    name: 'Spectrum +2A',
    snapshotId: 4,

    romPages: [
        { wasmPage: 70, file: 'plus3-0.rom', size: 16384 },
        { wasmPage: 71, file: 'plus3-1.rom', size: 16384 },
        { wasmPage: 72, file: 'plus3-2.rom', size: 16384 },
        { wasmPage: 73, file: 'plus3-3.rom', size: 16384 },
    ],
    ramPageCount: 8,

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xfc,
    contentionPattern: '76543210',
    contendedPages: [4, 5, 6, 7],

    pagingMode: 'plus3',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },
        { mask: 0xf002, match: 0x1000, role: 'paging2' },
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
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [70, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },
};
