/**
 * Scorpion ZS 256.
 *
 * Two memory ports (+3-style decode):
 *   0x7ffd  — primary paging. bits 0..2 = page low bits, bit 3 = screen,
 *             bit 4 = ROM select, bit 5 = lock.
 *   0x1ffd  — secondary paging. bit 0 = "RAM at $0000", bit 1 = TR-DOS ROM,
 *             bit 4 = page bit 3 (extends RAM to 16 pages = 256 KiB).
 *
 * No ULA contention, AY-3-8912 fitted, Beta128 built-in (later-style).
 *
 * The Scorpion uses four 16 KiB ROM banks (scorpion-0..3) plus TR-DOS.
 * These ROMs are not freely redistributable — supply them separately
 * under static/roms/ as scorpion-0.rom etc.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const scorpion = {
    id: 9,
    name: 'Scorpion ZS 256',
    snapshotId: 9,

    romPages: [
        { wasmPage: 74, file: 'scorpion-0.rom', size: 16384 },
        { wasmPage: 75, file: 'scorpion-1.rom', size: 16384 },
        { wasmPage: 76, file: 'scorpion-2.rom', size: 16384 },
        { wasmPage: 77, file: 'scorpion-3.rom', size: 16384 },
    ],
    // Scorpion-2 selected by 0x1ffd bit 1; Scorpion-3 replaces TR-DOS as
    // the beta M1-trap target ROM (loaded into the beta ROMCS bank).
    rom2Page: 76,
    betaRomPage: 77,
    ramPageCount: 16,

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xff,
    contentionPattern: 'none',
    contendedPages: [],

    pagingMode: 'scorpion',
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
        { type: 'beta128' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [74, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },
};
