/*
 * Internal Disk model used by all controller emulations.
 *
 * A Disk has:
 *   - cylinders (number of tracks per side)
 *   - sides (1 or 2)
 *   - tracks: 2D array [cyl][side] → Track
 *
 * A Track has:
 *   - sectors: array of Sector
 *
 * A Sector has:
 *   - c, h, r, n     CHRN address (n = log2(size/128); 1=256, 2=512, 3=1024)
 *   - data           Uint8Array of decoded sector contents
 *   - status1, status2  FDC status bytes from the source image (0 if unknown)
 *
 * Controllers index by (cylinder, side, sector-number-R) — they do not assume
 * any particular interleave or skew.
 */

export class Disk {
    constructor({ cylinders, sides }) {
        this.cylinders = cylinders;
        this.sides = sides;
        this.tracks = [];
        for (let c = 0; c < cylinders; c++) {
            const row = [];
            for (let s = 0; s < sides; s++) row.push({ sectors: [] });
            this.tracks.push(row);
        }
        this.writeProtect = true;
    }

    /** @returns {?{c,h,r,n,data,status1,status2}} */
    findSector(cyl, side, r) {
        if (cyl < 0 || cyl >= this.cylinders) return null;
        if (side < 0 || side >= this.sides) return null;
        const track = this.tracks[cyl][side];
        for (const sec of track.sectors) {
            if (sec.r === r) return sec;
        }
        return null;
    }
}
