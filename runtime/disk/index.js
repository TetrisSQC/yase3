/*
 * Floppy disk subsystem.
 *
 * Provides:
 *   - FDC chip emulation: wdFdc.js (WD1770/1772/1773), updFdc.js (NEC UPD765A).
 *   - Disk image parsers: trd.js, scl.js, mgt.js, img.js, sad.js, fdi.js, udi.js,
 *     dsk.js (CPC/EDSK), opd.js, d40_d80.js.
 *   - Internal Disk model: cylinders × sides × tracks with FM/MFM clock-mark
 *     bitmaps, weak-sector handling.
 *   - Floppy drive state (fdd.js) — head position, motor, write protect.
 */

export {};
