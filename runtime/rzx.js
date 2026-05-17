/*
 * RZX recording / playback file format. Minimal subset of the public spec
 * (https://www.worldofspectrum.org/RZX/) that the standard Spectrum
 * emulators understand:
 *
 *   - File header  (signature + version + flags)
 *   - 0x10 Creator info
 *   - 0x30 Snapshot   (uncompressed .z80 v3)
 *   - 0x80 Input recording (uncompressed frames)
 *
 * No compression. Frames stored as:
 *   u16 fetches    — M1 fetch count for the frame
 *   u16 num_in     — number of port-IN bytes captured this frame
 *   u8  bytes[num_in]
 *   (a num_in of 0xFFFF marks "repeat the previous frame's IN list")
 */

const SIGNATURE = 'RZX!';

const BLOCK_CREATOR  = 0x10;
const BLOCK_SNAPSHOT = 0x30;
const BLOCK_INPUT    = 0x80;

const CREATOR_ID = 'jsspeccy3 (caveman)\0'.padEnd(20, '\0');

function writeU16LE(buf, off, v) { buf[off] = v & 0xff; buf[off + 1] = (v >> 8) & 0xff; }
function writeU32LE(buf, off, v) {
    buf[off]     =  v        & 0xff;
    buf[off + 1] = (v >> 8)  & 0xff;
    buf[off + 2] = (v >> 16) & 0xff;
    buf[off + 3] = (v >> 24) & 0xff;
}
function readU16LE(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function readU32LE(buf, off) {
    return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * Encode the recording into a Uint8Array buffer.
 * @param {Uint8Array} snapshotZ80      — initial .z80 snapshot bytes
 * @param {Array<{fetches:number, inputs:Uint8Array}>} frames
 */
export function writeRzx(snapshotZ80, frames) {
    const tStart = 0;     // T-state count at frame 0 (unknown — leave 0)

    // -- Header --
    const headerLen = 10;

    // -- Creator block --
    const creatorLen = 5 + 20 + 2 + 2 + 0;     // id, version_major u16, version_minor u16, extra=0
    // -- Snapshot block --
    // 0x30 layout: 5-byte block header + 4 flags + 4 uncompressed length + 4 extension + data
    const snapBodyLen = 4 + 4 + 4 + snapshotZ80.length;
    const snapBlockLen = 5 + snapBodyLen;
    // -- Input block --
    let frameBytes = 0;
    for (const f of frames) frameBytes += 4 + f.inputs.length;     // u16 fetches + u16 num_in + bytes
    const inputBodyLen = 4 + 1 + 4 + 4 + frameBytes;
    const inputBlockLen = 5 + inputBodyLen;

    const total = headerLen + creatorLen + snapBlockLen + inputBlockLen;
    const out = new Uint8Array(total);
    let off = 0;

    // Header
    out[off++] = 0x52; out[off++] = 0x5a; out[off++] = 0x58; out[off++] = 0x21;    // "RZX!"
    out[off++] = 0x00;     // major version
    out[off++] = 0x0d;     // minor version (RZX 0.13)
    writeU32LE(out, off, 0); off += 4;          // flags

    // Creator block
    out[off++] = BLOCK_CREATOR;
    writeU32LE(out, off, creatorLen); off += 4;
    for (let i = 0; i < 20; i++) out[off++] = CREATOR_ID.charCodeAt(i);
    writeU16LE(out, off, 1); off += 2;          // version major
    writeU16LE(out, off, 0); off += 2;          // version minor

    // Snapshot block
    out[off++] = BLOCK_SNAPSHOT;
    writeU32LE(out, off, snapBlockLen); off += 4;
    writeU32LE(out, off, 0); off += 4;          // flags = 0 (uncompressed, embedded)
    writeU32LE(out, off, snapshotZ80.length); off += 4;
    out[off++] = 0x2e; out[off++] = 0x7a; out[off++] = 0x38; out[off++] = 0x30;    // ".z80"
    out.set(snapshotZ80, off); off += snapshotZ80.length;

    // Input block
    out[off++] = BLOCK_INPUT;
    writeU32LE(out, off, inputBlockLen); off += 4;
    writeU32LE(out, off, frames.length); off += 4;
    out[off++] = 0;                              // reserved
    writeU32LE(out, off, tStart); off += 4;     // initial t-state
    writeU32LE(out, off, 0); off += 4;          // flags (uncompressed)
    for (const f of frames) {
        writeU16LE(out, off, f.fetches & 0xffff); off += 2;
        writeU16LE(out, off, f.inputs.length & 0xffff); off += 2;
        out.set(f.inputs, off); off += f.inputs.length;
    }
    return out;
}

/**
 * Decode an RZX file. Returns { snapshotZ80, frames }.
 * Compressed input blocks are not supported — caller should reject.
 */
export function readRzx(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 10) throw new Error('RZX: file too small');
    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (sig !== SIGNATURE) throw new Error(`RZX: bad signature "${sig}"`);

    let off = 10;
    let snapshotZ80 = null;
    let frames = [];
    let lastInputs = new Uint8Array(0);

    while (off < bytes.length) {
        const id = bytes[off]; const len = readU32LE(bytes, off + 1);
        const nextOff = off + len;
        if (len < 5 || nextOff > bytes.length) {
            throw new Error(`RZX: bad block length ${len} at offset ${off}`);
        }
        const body = bytes.subarray(off + 5, nextOff);

        if (id === BLOCK_SNAPSHOT) {
            const flags = readU32LE(body, 0);
            if (flags & 1) throw new Error('RZX: external snapshot refs not supported');
            if (flags & 2) throw new Error('RZX: compressed snapshot not supported');
            const uncompressedLength = readU32LE(body, 4);
            const ext = String.fromCharCode(body[8], body[9], body[10], body[11]);
            if (ext.trim() !== '.z80' && ext.trim() !== '.z80\0')
                console.warn(`RZX: snapshot extension "${ext}" — only .z80 fully supported`);
            snapshotZ80 = body.slice(12, 12 + uncompressedLength);
        } else if (id === BLOCK_INPUT) {
            const numFrames = readU32LE(body, 0);
            const flags = readU32LE(body, 9);
            if (flags & 2) throw new Error('RZX: compressed input block not supported');
            let p = 13;
            for (let i = 0; i < numFrames; i++) {
                if (p + 4 > body.length) throw new Error('RZX: truncated input block');
                const fetches = readU16LE(body, p); p += 2;
                const numIn   = readU16LE(body, p); p += 2;
                if (numIn === 0xffff) {
                    frames.push({ fetches, inputs: lastInputs });
                } else {
                    if (p + numIn > body.length) throw new Error('RZX: truncated input data');
                    const inputs = body.slice(p, p + numIn);
                    p += numIn;
                    frames.push({ fetches, inputs });
                    lastInputs = inputs;
                }
            }
        }
        // Other blocks ignored.
        off = nextOff;
    }
    if (!snapshotZ80) throw new Error('RZX: missing snapshot block');
    return { snapshotZ80, frames };
}
