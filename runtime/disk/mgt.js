/*
 * +D / DISCiPLE MGT disk image (.mgt).
 *
 * Layout: linear 512-byte sectors, 10 sectors per track, 80 cylinders, 2
 * sides. Track interleave: cyl 0 side 0, cyl 0 side 1, cyl 1 side 0, ...
 * Sectors numbered 1..10. Some images may be short — zero-fill the tail.
 */

import { Disk } from './disk.js';

const SECTOR_SIZE = 512;
const SECTORS_PER_TRACK = 10;
const CYLINDERS = 80;
const SIDES = 2;

export function parseMgt(arrayBuffer) {
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
                    data = new Uint8Array(SECTOR_SIZE);
                }
                offset += SECTOR_SIZE;
                track.sectors.push({
                    c, h: s, r, n: 2,    // n=2 → 512-byte sector
                    data,
                    status1: 0, status2: 0,
                });
            }
        }
    }
    disk.writeProtect = false;
    return disk;
}

export function isMgtImage(filename) {
    return /\.(mgt|img)$/i.test(filename);
}

/** Re-serialise a Disk back to .mgt linear bytes. */
export function writeMgt(disk) {
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
