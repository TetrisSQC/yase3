/**
 * ZX Spectrum +3e (community-modified +3 with IDE-style ROM bank extensions).
 *
 * Same paging as +3 plus the +3e ROMs which add IDE driver code. The IDE
 * interface itself is out of scope; +3e is included for ROM/machine
 * compatibility with snapshots that carry ZXST machine-id 12.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const specplus3e = {
    id: 12,
    name: 'Spectrum +3e',
    snapshotId: 12,

    romPages: [
        { wasmPage: 70, file: 'plus3e-0.rom', size: 16384 },
        { wasmPage: 71, file: 'plus3e-1.rom', size: 16384 },
        { wasmPage: 72, file: 'plus3e-2.rom', size: 16384 },
        { wasmPage: 73, file: 'plus3e-3.rom', size: 16384 },
    ],
    ramPageCount: 8,

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xfc,
    contentionPattern: '76543210',
    contendedPages: [4, 5, 6, 7],

    pagingMode: 'plus3e',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },
        { mask: 0xf002, match: 0x1000, role: 'paging2' },
        { mask: 0xc002, match: 0xc000, role: 'aySelect' },
        { mask: 0xc002, match: 0x8000, role: 'ayData' },
        { mask: 0x00e0, match: 0x0000, role: 'kempston' },
        { mask: 0xf002, match: 0x2000, role: 'fdcStatus' },
        { mask: 0xf002, match: 0x3000, role: 'fdcData' },
    ],
    screenPages: [5, 7],
    timex: false,
    ay: 'sinclair',

    periph: [
        { type: 'ula' },
        { type: 'ay' },
        { type: 'kempston' },
        { type: 'upd765' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [70, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },
};
