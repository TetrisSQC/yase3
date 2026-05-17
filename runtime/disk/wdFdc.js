/*
 * Western Digital WD1770/1772/1773 floppy disk controller — minimal
 * read-only emulation.
 *
 * Implemented well enough for TR-DOS and standard Beta128 / +D / DISCiPLE /
 * Opus loaders that read sectors. Not implemented yet:
 *   - Type III: Read Track / Write Track / Format
 *   - Type II:  Write Sector (we accept the command but discard data)
 *   - Forced Interrupt with index-pulse condition
 *   - Cycle-accurate DRQ rate (DRQ is set as soon as a byte is available)
 *
 * Reference: Western Digital FD1770 Floppy Disk Controller datasheet.
 *
 * The Beta128 / TR-DOS expects sector numbers starting at 1.
 */

const STATUS_BUSY        = 0x01;
const STATUS_DRQ         = 0x02;
const STATUS_LOST_DATA   = 0x04;
const STATUS_CRC_ERROR   = 0x08;
const STATUS_RNF         = 0x10;  // Record Not Found (Type II)
const STATUS_INDEX       = 0x02;  // Type I only — overlaps with DRQ semantically
const STATUS_TRACK0      = 0x04;
const STATUS_HEAD_LOADED = 0x20;
const STATUS_WRITE_PROT  = 0x40;
const STATUS_NOT_READY   = 0x80;

export class WdFdc {
    constructor({ numDrives = 4 } = {}) {
        this.drives = [];
        for (let i = 0; i < numDrives; i++) {
            this.drives.push({ disk: null, track: 0, side: 0 });
        }
        this.currentDrive = 0;
        this.statusRegister = 0;
        this.trackRegister = 0;
        this.sectorRegister = 1;
        this.dataRegister = 0;
        this.lastCommand = 0;

        this.readBuffer = null;
        this.readPos = 0;

        // Direction bit for the next stepping command without an explicit
        // direction (STEP/STEP-AND-UPDATE).
        this.stepDirection = +1;
    }

    insert(driveIndex, disk) {
        if (!this.drives[driveIndex]) return;
        this.drives[driveIndex].disk = disk;
    }

    eject(driveIndex) {
        if (!this.drives[driveIndex]) return;
        this.drives[driveIndex].disk = null;
    }

    selectDrive(driveIndex) { this.currentDrive = driveIndex & 0x03; }
    selectSide(side)        { this.drives[this.currentDrive].side = side & 1; }

    _drive() { return this.drives[this.currentDrive]; }
    _disk() { return this._drive().disk; }

    /** Status read. Clears INTRQ. */
    readStatus() {
        let s = this.statusRegister;
        const d = this._drive();
        if (!d.disk) s |= STATUS_NOT_READY;
        if (d.track === 0) s |= STATUS_TRACK0;
        return s;
    }
    readTrack()  { return this.trackRegister; }
    readSector() { return this.sectorRegister; }
    readData() {
        if (this.readBuffer && this.readPos < this.readBuffer.length) {
            const v = this.readBuffer[this.readPos++];
            if (this.readPos >= this.readBuffer.length) {
                this.readBuffer = null;
                this.statusRegister &= ~(STATUS_BUSY | STATUS_DRQ);
            }
            return v;
        }
        this.statusRegister &= ~STATUS_DRQ;
        return this.dataRegister;
    }

    writeTrack(val)  { this.trackRegister = val & 0xff; }
    writeSector(val) { this.sectorRegister = val & 0xff; }
    writeData(val)   { this.dataRegister = val & 0xff; }

    /** Command register write — dispatches by top-nibble pattern. */
    writeCommand(cmd) {
        this.lastCommand = cmd;
        const type = (cmd >> 4) & 0x0f;

        // Type IV — Force Interrupt (0xD0..0xDF)
        if ((cmd & 0xf0) === 0xd0) {
            this.statusRegister &= ~(STATUS_BUSY | STATUS_DRQ);
            this.readBuffer = null;
            return;
        }
        // Type I — Restore (0x0n) / Seek (0x1n) / Step (0x2n..0x3n) /
        // Step-In (0x4n..0x5n) / Step-Out (0x6n..0x7n).
        if (type <= 7) {
            this._typeOne(cmd);
            return;
        }
        // Type II — Read Sector (0x8n / 0x9n) / Write Sector (0xAn / 0xBn).
        if (type === 8 || type === 9) {
            this._readSector(cmd);
            return;
        }
        if (type === 0xa || type === 0xb) {
            // Write Sector — accepted, data discarded. Sets the busy bit
            // briefly so loaders that poll for completion succeed.
            this.statusRegister |= STATUS_BUSY;
            this.statusRegister &= ~STATUS_BUSY;
            return;
        }
        // Type III — Read Address (0xCn) / Read Track (0xEn) / Write Track
        // (0xFn). Stubbed as RNF.
        this.statusRegister = STATUS_RNF;
    }

    _typeOne(cmd) {
        const type = (cmd >> 4) & 0x0f;
        const update = (cmd & 0x10) !== 0;
        const d = this._drive();
        if (type === 0) {
            // Restore — step to track 0
            d.track = 0;
            this.trackRegister = 0;
        } else if (type === 1) {
            // Seek to track in data register
            const target = this.dataRegister;
            d.track = target;
            this.trackRegister = target;
        } else if (type === 2 || type === 3) {
            // Step in last direction
            d.track = Math.max(0, d.track + this.stepDirection);
            if (update) this.trackRegister = d.track;
        } else if (type === 4 || type === 5) {
            // Step in (toward higher tracks)
            this.stepDirection = +1;
            d.track = d.track + 1;
            if (update) this.trackRegister = d.track;
        } else if (type === 6 || type === 7) {
            // Step out (toward track 0)
            this.stepDirection = -1;
            d.track = Math.max(0, d.track - 1);
            if (update) this.trackRegister = d.track;
        }
        this.statusRegister = STATUS_HEAD_LOADED;
        // Beta128 polls bit 7 (NOT READY) to detect drive presence; clear
        // the busy bit immediately so seeks appear instant.
    }

    _readSector(cmd) {
        const disk = this._disk();
        if (!disk) {
            this.statusRegister = STATUS_NOT_READY;
            return;
        }
        const side = this._drive().side;
        const sec = disk.findSector(this.trackRegister, side, this.sectorRegister);
        if (!sec) {
            this.statusRegister = STATUS_RNF;
            return;
        }
        this.readBuffer = sec.data;
        this.readPos = 0;
        this.statusRegister = STATUS_BUSY | STATUS_DRQ;
    }
}
