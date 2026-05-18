/**
 * ZX Spectrum Next — *stub* registration.
 *
 * The real ZX Spectrum Next is an FPGA reimplementation with substantial
 * extensions over a stock 128K Spectrum:
 *   - Z80n CPU (extra opcodes: MUL, SWAPNIB, MIRROR, PUSH nn, LDIX, etc.)
 *   - NextREG register file via I/O ports 0x243B / 0x253B (300+ regs)
 *   - 8K-paged MMU spanning up to 2 MB internal RAM (16 banks of 8 K)
 *   - Layer 2 256×192×256-colour bitmap
 *   - Tilemap mode (640×256 character cells)
 *   - Sprites (64 hardware sprites with priority + clip)
 *   - Copper (per-scanline NextREG patcher)
 *   - DMA controller (Zilog Z80 DMA-compatible)
 *   - Triple AY + 8-bit DAC audio
 *   - SD card, Wi-Fi, joystick, accel
 *
 * None of that is emulated by the wasm core in this project. We register
 * the machine so the menu shows it and the ROMs load, but the CPU will
 * almost certainly run into a Z80n opcode and stop on first boot, since
 * the wasm Z80 core returns status 1 (unrecognised opcode) for those.
 *
 * For real Next emulation use the jnext project (separate C++ codebase).
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const specNext = {
    id: 99,
    name: 'ZX Spectrum Next (stub)',
    snapshotId: 99,

    /* 4 × 16 K ROMs occupy slots 90-93 (free range). next-0 maps to slot 0
       at boot (the 48K BASIC compatibility ROM). Other ROMs unused without
       NextREG ROM-bank selection. */
    romPages: [
        { wasmPage: 90, file: 'next-0.rom', size: 16384 },
        { wasmPage: 91, file: 'next-1.rom', size: 16384 },
        { wasmPage: 92, file: 'next-2.rom', size: 16384 },
        { wasmPage: 93, file: 'next-3.rom', size: 16384 },
    ],
    ramPageCount: 8,    // 128K-equivalent allocation (real Next: 96-128 pages)

    frameTstates: 70908,
    firstScreenTstate: 14361,
    scanlineTstates: 228,
    borderTimeMask: 0xff,
    contentionPattern: 'none',
    contendedPages: [],

    pagingMode: '128',
    portDecodes: [
        { mask: 0x0001, match: 0x0000, role: 'ulaPort' },
        { mask: 0xc002, match: 0x4000, role: 'paging1' },
        { mask: 0xc002, match: 0xc000, role: 'aySelect' },
        { mask: 0xc002, match: 0x8000, role: 'ayData' },
    ],
    screenPages: [5, 7],
    timex: false,
    ay: 'sinclair',

    periph: [
        { type: 'ula' },
        { type: 'ay' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [90, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: false,
        screenPage: 5,
    },
};
