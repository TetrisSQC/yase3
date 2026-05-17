/**
 * ZX Spectrum +3 (black case with internal 3" disk drive).
 *
 * Same paging + ROMs as +2A; adds a UPD765 FDC at ports 0x2ffd/0x3ffd. The
 * full UPD765 implementation lands in Phase 8 (disk emulation). Until then,
 * the 'upd765' peripheral is a no-op stub; the rest of the machine works
 * tape-only just like +2A.
 *
 * Public registry id is 15 to avoid clashing with Pentagon-128 (=5). The
 * ZXST machine-id byte for +3 snapshots remains 5; the snapshot loader maps
 * it to registry id 15.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const specplus3 = {
    id: 15,
    name: 'Spectrum +3',
    snapshotId: 5,

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
