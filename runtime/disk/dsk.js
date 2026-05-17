/*
 * CPC / Spectrum +3 DSK image (.dsk).
 *
 * Two flavours share the disk-info header:
 *   - Standard:    "MV - CPCEMU Disk-File\r\nDisk-Info\r\n"
 *   - Extended:    "EXTENDED CPC DSK File\r\nDisk-Info\r\n"
 *
 * Standard format records one fixed track size in the disk-info header;
 * extended format has a per-track size table (in 256-byte units) which
 * allows per-track variation (e.g. copy-protected disks).
 *
 * Each track is preceded by a "Track-Info\r\n" header that describes its
 * sector list (CHRN, FDC status bytes, length). Sector data follows the
 * track header at offset 0x100 within the track.
 *
 * Reference: CPCWiki — http://www.cpcwiki.eu/index.php/Format:DSK_disk_image_file_format
 */

import { Disk } from './disk.js';

const DISK_INFO_LEN = 0x100;
const TRACK_HEADER_LEN = 0x100;

export function parseDsk(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const headerStr = readString(bytes, 0, 0x22);
    const isExtended = headerStr.startsWith('EXTENDED');
    if (!isExtended && !headerStr.startsWith('MV - CPC')) {
        throw new Error('Not a recognised DSK image');
    }

    const cylindersInImage = view.getUint8(0x30);
    const sides = view.getUint8(0x31);
    const trackSizeFixed = isExtended ? 0 : view.getUint16(0x32, true);
    // Extended track size table: one byte per (cyl × side) entry, units of
    // 256 bytes. 0 = no data for that track.
    const trackSizes = [];
    for (let i = 0; i < cylindersInImage * sides; i++) {
        if (isExtended) {
            trackSizes.push(view.getUint8(0x34 + i) * 256);
        } else {
            trackSizes.push(trackSizeFixed);
        }
    }

    const disk = new Disk({ cylinders: cylindersInImage, sides });
    let offset = DISK_INFO_LEN;
    for (let c = 0; c < cylindersInImage; c++) {
        for (let s = 0; s < sides; s++) {
            const trackSize = trackSizes[c * sides + s];
            if (trackSize === 0) continue;
            parseTrack(disk, bytes, view, offset, c, s);
            offset += trackSize;
        }
    }

    disk.writeProtect = false;
    return disk;
}

function parseTrack(disk, bytes, view, base, expectedCyl, expectedSide) {
    const tag = readString(bytes, base, 12);
    if (!tag.startsWith('Track-Info')) {
        throw new Error(`Missing Track-Info tag at offset 0x${base.toString(16)}`);
    }
    // Track header fields at offsets relative to base:
    //   0x10  track number (cylinder)
    //   0x11  side
    //   0x14  sector size (N value; sector bytes = 128 << N)
    //   0x15  number of sectors
    //   0x16  GAP3 length
    //   0x17  filler byte
    //   0x18  sector list: 8 bytes per sector
    const cyl = view.getUint8(base + 0x10);
    const side = view.getUint8(base + 0x11);
    const numSectors = view.getUint8(base + 0x15);

    const track = disk.tracks[cyl][side];
    let sectorDataOffset = base + TRACK_HEADER_LEN;

    for (let i = 0; i < numSectors; i++) {
        const so = base + 0x18 + i * 8;
        const c = view.getUint8(so + 0);
        const h = view.getUint8(so + 1);
        const r = view.getUint8(so + 2);
        const n = view.getUint8(so + 3);
        const status1 = view.getUint8(so + 4);
        const status2 = view.getUint8(so + 5);
        // For extended DSK: actual data length is taken from the per-sector
        // length word (offset +6). For standard DSK it's (128 << N).
        const dataLength = view.getUint16(so + 6, true) || (128 << n);
        const data = bytes.subarray(sectorDataOffset, sectorDataOffset + dataLength);
        sectorDataOffset += dataLength;

        track.sectors.push({ c, h, r, n, data, status1, status2 });
    }
}

function readString(bytes, offset, length) {
    let s = '';
    for (let i = 0; i < length; i++) {
        const b = bytes[offset + i];
        if (b === 0) break;
        s += String.fromCharCode(b);
    }
    return s;
}

export function isDskImage(filename) {
    return /\.dsk$/i.test(filename);
}
