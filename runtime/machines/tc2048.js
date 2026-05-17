/**
 * Timex TC2048.
 *
 * 48K Spectrum clone with the SCLD chip (hires + dual-screen + dock/exrom
 * paging via port 0xff / 0xf4). No 128K-style paging. ULA + Kempston joystick
 * use full-address port decode.
 *
 * Display modes beyond the standard 256x192 attr-cell are stubbed at the
 * port level only — full hires rendering is a future framebuffer-rework
 * item. Programs run; in hires-only games the picture is incorrect.
 *
 * @type {import('./machineDef.js').MachineDef}
 */
export const tc2048 = {
    id: 14,
    name: 'Timex TC2048',
    snapshotId: 14,

    romPages: [
        { wasmPage: 64, file: 'tc2048.rom', size: 16384 },
    ],
    ramPageCount: 3,

    frameTstates: 69888,
    firstScreenTstate: 14335,
    scanlineTstates: 224,
    borderTimeMask: 0xfc,
    contentionPattern: '65432100',
    contendedPages: [5],

    pagingMode: 'timexScld',
    portDecodes: [
        { mask: 0x00ff, match: 0x00fe, role: 'ulaPort' },  // full decode
        { mask: 0x00ff, match: 0x00ff, role: 'scld' },
        { mask: 0x00ff, match: 0x00f4, role: 'scldHsr' },
        { mask: 0x00ff, match: 0x001f, role: 'kempston' }, // full decode
    ],
    screenPages: [5, 7],
    timex: true,
    ay: 'none',

    periph: [
        { type: 'ula' },
        { type: 'kempston' },
        { type: 'scld' },
    ],
    defaultJoystick: 'kempston',

    resetState: {
        readMap: [64, 5, 2, 0],
        writeMap: [69, 5, 2, 0],
        pagingLocked: true,
        screenPage: 5,
    },
};
