/*
 * ZX Microdrive cartridge image (.mdr) parser.
 *
 * Format: 137,923 bytes of cartridge data + 1 trailing byte = write-protect
 * flag (non-zero ⇒ write-protected).
 *
 * Cartridge layout: 254 sectors of 543 bytes each.
 *   543 = 12 bytes preamble + 1 byte head sector + 15 bytes header data
 *       + 1 byte header checksum + 12 bytes data preamble + 1 byte head
 *       data + 1 byte data block number + 2 bytes data length + 512 bytes
 *       data + 1 byte data checksum.
 *
 *   (The bit-level emulation only needs the raw 543×254 stream.)
 */

const CART_SIZE = 543 * 254;        // 137,922
const FILE_SIZE = CART_SIZE + 1;    // + 1 write-protect byte

export function parseMdr(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < CART_SIZE) {
        throw new Error(`parseMdr: file too short (${bytes.length} bytes; expected at least ${CART_SIZE})`);
    }
    const data = new Uint8Array(CART_SIZE);
    data.set(bytes.subarray(0, CART_SIZE));
    const writeProtect = bytes.length > CART_SIZE ? bytes[CART_SIZE] !== 0 : false;
    return { data, writeProtect };
}

export function writeMdr({ data, writeProtect }) {
    const out = new Uint8Array(FILE_SIZE);
    out.set(data.subarray(0, CART_SIZE), 0);
    out[CART_SIZE] = writeProtect ? 1 : 0;
    return out;
}

export function isMdrImage(filename) {
    return /\.mdr$/i.test(filename);
}

export const MDR_CART_SIZE = CART_SIZE;
