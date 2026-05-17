/*
 * Z80 v3 snapshot writer. Emits a standard `.z80` file readable by
 * common Spectrum emulators.
 *
 * v3 layout:
 *   bytes  0..29   standard header (PC at offsets 6,7 forced to 0 so v2/v3 readers
 *                  pick up the extended PC from offset 32)
 *   bytes 30..31   additional header length (54 for v3)
 *   bytes 32..85   v3 extended header
 *   bytes 86+      memory pages: each prefixed by a 3-byte header
 *                  [length_lo, length_hi, page_id]. length == 0xFFFF marks
 *                  an uncompressed 0x4000-byte page; we always emit
 *                  uncompressed for simplicity.
 *
 * @typedef {Object} ExportState
 * @property {Uint16Array} regs   12 register pairs (AF, BC, DE, HL, AF', BC', DE', HL', IX, IY, SP, IR)
 * @property {number} pc
 * @property {number} iff1
 * @property {number} iff2
 * @property {number} im
 * @property {number} tstates
 * @property {number} halted
 * @property {number} machineModel  48 | 128 | 5 (pentagon) | etc
 * @property {number} pagingFlags   value of port 0x7ffd (0 for 48K)
 * @property {number} borderColour
 * @property {Map<number, Uint8Array>} pages   page number → 16 K bytes
 */

const V3_EXTRA_HEADER = 54;

export function writeZ80(state) {
    const is48K = state.machineModel === 48;
    const pageIdByNumber = is48K
        ? { 5: 8, 2: 4, 0: 5 }        // 48K: page 5 → ID 8, page 2 → ID 4, page 0 → ID 5
        : { 0: 3, 1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10 };

    const pageEntries = [];
    for (const [num, bytes] of state.pages) {
        const id = pageIdByNumber[num];
        if (id === undefined) continue;
        pageEntries.push({ id, bytes });
    }

    const totalSize = 32 + 2 + V3_EXTRA_HEADER + pageEntries.length * (3 + 0x4000);
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    const regs = state.regs;
    // bytes 0..29 — standard header.
    view.setUint16(0, regs[0], false);            // AF (big-endian)
    view.setUint16(2, regs[1], true);             // BC
    view.setUint16(4, regs[3], true);             // HL
    view.setUint16(6, 0, true);                   // PC = 0 → v2/v3 marker
    view.setUint16(8, regs[10], true);            // SP
    view.setUint8 (10, (regs[11] >> 8) & 0xff);   // I (high byte of IR)
    const rLow = regs[11] & 0xff;
    view.setUint8 (11, rLow & 0x7f);              // R (bit 7 cleared)
    view.setUint8 (12, ((rLow >> 7) & 0x01) | ((state.borderColour & 0x07) << 1)); // bit 0 = R bit 7, bits 1-3 = border
    view.setUint16(13, regs[2], true);            // DE
    view.setUint16(15, regs[5], true);            // BC'
    view.setUint16(17, regs[6], true);            // DE'
    view.setUint16(19, regs[7], true);            // HL'
    view.setUint16(21, regs[4], false);           // AF' (big-endian)
    view.setUint16(23, regs[9], true);            // IY
    view.setUint16(25, regs[8], true);            // IX
    view.setUint8 (27, state.iff1 ? 0xff : 0);
    view.setUint8 (28, state.iff2 ? 0xff : 0);
    view.setUint8 (29, state.im & 0x03);

    // bytes 30..31 — additional header length.
    view.setUint16(30, V3_EXTRA_HEADER, true);

    // bytes 32..33 — PC (real).
    view.setUint16(32, state.pc, true);
    // byte 34 — machine model ID. v3 IDs:
    //   0 = 48K, 4 = 128K (Pentagon = 9, +3 = 7, but 4 is the conservative default).
    let machineId = 0;
    if (state.machineModel === 48) machineId = 0;
    else if (state.machineModel === 5) machineId = 9;   // Pentagon
    else if (state.machineModel === 7) machineId = 12;  // +3
    else machineId = 4;                                 // 128K (default for everything else)
    view.setUint8(34, machineId);
    view.setUint8(35, is48K ? 0 : (state.pagingFlags & 0xff));   // last out 7ffd
    view.setUint8(36, 0);   // IF1 paged in
    view.setUint8(37, 0);   // R-emulation flags
    view.setUint8(38, 0);   // last out to 0xfffd (AY register select)
    // bytes 39..54 — AY register dump (16 bytes) — leave zero.
    // bytes 55..56 — low t-state count, byte 57 — high chunk.
    const frameTstates = is48K ? 69888 : 70908;
    const tstateChunkSize = (frameTstates / 4) | 0;
    const tInChunk = state.tstates % tstateChunkSize;
    const chunkIndex = (state.tstates / tstateChunkSize) | 0;
    const t_lo_word = (tstateChunkSize - 1 - tInChunk) & 0xffff;
    const t_hi      = ((chunkIndex + 3) % 4) & 0xff;
    view.setUint16(55, t_lo_word, true);
    view.setUint8(57, t_hi);

    // Memory pages.
    let offset = 32 + 2 + V3_EXTRA_HEADER;
    for (const { id, bytes } of pageEntries) {
        view.setUint16(offset, 0xffff, true);   // 0xffff → uncompressed 16K
        view.setUint8 (offset + 2, id);
        u8.set(bytes.subarray(0, 0x4000), offset + 3);
        offset += 3 + 0x4000;
    }
    return buf;
}
