/*
 * Warajevo .DCK Timex Dock cartridge parser.
 *
 * Format: stream of blocks. Each block starts with a 9-byte header followed
 * by 0..8 × 8 KB pages of raw data.
 *
 *   byte 0       bank designator
 *                  0 = HOME, 1 = DOCK, 2 = EXROM (other = unsupported)
 *   bytes 1..8   access type per 8 KB page (8 entries)
 *                  0 = absent (no data follows for this page)
 *                  1 = RAM (8 KB initialised data follows)
 *                  2 = RAM_EMPTY (no data follows; page is zero-init)
 *                  3 = ROM (8 KB data follows)
 *
 * Most ROM cartridges have a single block: bank=1 (DOCK), some pages = ROM.
 *
 * Returns { blocks: [{ bank, pages: [Uint8Array(8192) | null × 8] }] }
 *
 * Pages are returned with `null` for "absent" slots; RAM_EMPTY slots get a
 * zero-filled Uint8Array.
 */

const PAGE_SIZE = 0x2000;     // 8 KB
const PAGES_PER_BLOCK = 8;
const HEADER_SIZE = 9;

const ACCESS_NONE  = 0;
const ACCESS_RAM   = 1;
const ACCESS_EMPTY = 2;
const ACCESS_ROM   = 3;

export function parseDck(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const blocks = [];
    let offset = 0;

    while (offset + HEADER_SIZE <= bytes.length) {
        const bank = bytes[offset];
        const accesses = bytes.slice(offset + 1, offset + 9);
        offset += HEADER_SIZE;

        const pages = new Array(PAGES_PER_BLOCK).fill(null);
        for (let i = 0; i < PAGES_PER_BLOCK; i++) {
            const a = accesses[i];
            if (a === ACCESS_NONE) continue;
            if (a === ACCESS_EMPTY) {
                pages[i] = new Uint8Array(PAGE_SIZE);
                continue;
            }
            if (a === ACCESS_ROM || a === ACCESS_RAM) {
                if (offset + PAGE_SIZE > bytes.length) {
                    throw new Error('parseDck: truncated page data');
                }
                pages[i] = bytes.slice(offset, offset + PAGE_SIZE);
                offset += PAGE_SIZE;
            } else {
                throw new Error(`parseDck: unsupported access type ${a}`);
            }
        }

        blocks.push({ bank, pages });
        // End-of-stream check: many DCKs have trailing zero bytes / EOF.
        if (offset >= bytes.length) break;
    }

    return { blocks };
}

export function isDckImage(filename) {
    return /\.dck$/i.test(filename);
}
