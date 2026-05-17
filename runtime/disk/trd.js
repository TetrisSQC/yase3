/*
 * TR-DOS disk image (.trd).
 *
 * Layout: linear 256-byte sectors, 16 sectors per track, 80 cylinders, 2
 * sides. Order: cylinder 0 side 0, cylinder 0 side 1, cylinder 1 side 0, ...
 * Sectors are numbered 1..16 starting at sector 1.
 *
 * Some images are short — they only store as many bytes as the disk's used
 * area requires (per the volume info sector at cyl 0 side 0 sec 9). We
 * accept short images and zero-fill missing sectors.
 */

import { Disk } from './disk.js';

const SECTOR_SIZE = 256;
const SECTORS_PER_TRACK = 16;
const CYLINDERS = 80;
const SIDES = 2;

export function parseTrd(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const disk = new Disk({ cylinders: CYLINDERS, sides: SIDES });

    let offset = 0;
    for (let c = 0; c < CYLINDERS; c++) {
        for (let s = 0; s < SIDES; s++) {
            const track = disk.tracks[c][s];
            for (let r = 1; r <= SECTORS_PER_TRACK; r++) {
                let data;
                if (offset + SECTOR_SIZE <= bytes.length) {
                    data = bytes.subarray(offset, offset + SECTOR_SIZE);
                } else {
                    data = new Uint8Array(SECTOR_SIZE);  // zero-filled padding
                }
                offset += SECTOR_SIZE;
                track.sectors.push({
                    c, h: s, r, n: 1,                // n=1 → 256-byte sector
                    data,
                    status1: 0, status2: 0,
                });
            }
        }
    }
    disk.writeProtect = false;
    return disk;
}

export function isTrdImage(filename) {
    return /\.trd$/i.test(filename);
}

/** Re-serialise a Disk back to .trd linear bytes. */
export function writeTrd(disk) {
    const out = new Uint8Array(CYLINDERS * SIDES * SECTORS_PER_TRACK * SECTOR_SIZE);
    let offset = 0;
    for (let c = 0; c < CYLINDERS; c++) {
        for (let s = 0; s < SIDES; s++) {
            const track = disk.tracks[c]?.[s];
            for (let r = 1; r <= SECTORS_PER_TRACK; r++) {
                const sec = track ? track.sectors.find((sec) => sec.r === r) : null;
                if (sec) out.set(sec.data.subarray(0, SECTOR_SIZE), offset);
                offset += SECTOR_SIZE;
            }
        }
    }
    return out;
}
