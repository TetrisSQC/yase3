/*
 * NEC UPD765A floppy disk controller — minimal read-only emulation for the
 * Spectrum +3 / +2A.
 *
 * The UPD765 has three phases:
 *   COMMAND  — host writes command bytes (variable length per command).
 *   EXECUTION — controller transfers data with the host (read/write) or runs
 *               internal work (seek/recalibrate).
 *   RESULT   — host reads result bytes.
 *
 * MSR (Main Status Register, read on the status port):
 *   bit 7  RQM   ready for data transfer
 *   bit 6  DIO   direction: 1 = controller→host
 *   bit 5  EXM   in execution phase
 *   bit 4  CB    command busy
 *   bit 0..3    drive busy flags (D0..D3)
 *
 * Implemented commands (read-only subset):
 *   0x03 SPECIFY
 *   0x07 RECALIBRATE
 *   0x08 SENSE INTERRUPT STATUS
 *   0x04 SENSE DRIVE STATUS
 *   0x0F SEEK
 *   0x46 / 0x66 READ DATA (MT/SK/MF variants)
 *
 * Write commands return success without touching the disk (read-only mount).
 */

const MSR_RQM = 0x80;
const MSR_DIO = 0x40;  // 1 = ctrl→host
const MSR_EXM = 0x20;
const MSR_CB  = 0x10;

export class UpdFdc {
    constructor({ numDrives = 4 } = {}) {
        this.drives = [];
        for (let i = 0; i < numDrives; i++) {
            this.drives.push({ disk: null, track: 0, head: 0, ncn: 0 });
        }
        this.msr = MSR_RQM;
        this.cmdBuf = [];
        this.expectedCmdLen = 0;
        this.resultBuf = [];
        this.execBuf = null;
        this.execPos = 0;
        this.phase = 'cmd';  // 'cmd' | 'exec-read' | 'exec-write' | 'result'
        this.lastInterrupt = { st0: 0, pcn: 0 };
        this.intPending = false;
    }

    insert(drv, disk) { if (this.drives[drv]) this.drives[drv].disk = disk; }
    eject(drv)        { if (this.drives[drv]) this.drives[drv].disk = null; }

    /** Read MSR. Always available. */
    readStatus() { return this.msr; }

    /** Data register read. */
    readData() {
        if (this.phase === 'exec-read') {
            if (this.execBuf && this.execPos < this.execBuf.length) {
                const v = this.execBuf[this.execPos++];
                if (this.execPos >= this.execBuf.length) {
                    this._enterResultPhase(this._buildReadResult());
                }
                return v;
            }
        } else if (this.phase === 'result') {
            if (this.resultBuf.length > 0) {
                const v = this.resultBuf.shift();
                if (this.resultBuf.length === 0) {
                    this._enterCmdPhase();
                }
                return v;
            }
        }
        return 0xff;
    }

    /** Data register write. */
    writeData(val) {
        val &= 0xff;
        if (this.phase !== 'cmd' && this.phase !== 'exec-write') return;
        if (this.phase === 'cmd') {
            this.cmdBuf.push(val);
            if (this.cmdBuf.length === 1) {
                this.expectedCmdLen = this._cmdLen(val);
            }
            if (this.cmdBuf.length >= this.expectedCmdLen) {
                this._executeCommand();
            }
        }
        // exec-write phase: write data is currently discarded.
    }

    _cmdLen(cmd) {
        switch (cmd & 0x1f) {
            case 0x03: return 3;  // SPECIFY
            case 0x04: return 2;  // SENSE DRIVE STATUS
            case 0x05: return 9;  // WRITE DATA
            case 0x06: return 9;  // READ DATA
            case 0x07: return 2;  // RECALIBRATE
            case 0x08: return 1;  // SENSE INTERRUPT STATUS
            case 0x0a: return 2;  // READ ID
            case 0x0c: return 9;  // READ DELETED DATA
            case 0x0d: return 6;  // FORMAT TRACK
            case 0x0f: return 3;  // SEEK
            case 0x11: return 9;  // SCAN EQUAL
            default:   return 1;  // INVALID → result phase with ST0=0x80
        }
    }

    _executeCommand() {
        const cmd = this.cmdBuf[0];
        const opcode = cmd & 0x1f;
        switch (opcode) {
            case 0x03: this._cmdSpecify(); break;
            case 0x04: this._cmdSenseDriveStatus(); break;
            case 0x06: this._cmdReadData(); break;
            case 0x07: this._cmdRecalibrate(); break;
            case 0x08: this._cmdSenseInterrupt(); break;
            case 0x0f: this._cmdSeek(); break;
            default:
                // INVALID — return ST0 = 0x80.
                this._enterResultPhase([0x80]);
                break;
        }
    }

    _cmdSpecify() {
        // Two timing bytes — ignore.
        this._enterCmdPhase();
    }

    _cmdRecalibrate() {
        const drv = this.cmdBuf[1] & 0x03;
        const d = this.drives[drv];
        d.track = 0;
        d.ncn = 0;
        this.lastInterrupt = { st0: 0x20 | drv, pcn: 0 };
        this.intPending = true;
        this._enterCmdPhase();
    }

    _cmdSeek() {
        const headDrive = this.cmdBuf[1];
        const ncn = this.cmdBuf[2];
        const drv = headDrive & 0x03;
        const head = (headDrive >> 2) & 1;
        const d = this.drives[drv];
        d.track = ncn;
        d.head = head;
        d.ncn = ncn;
        this.lastInterrupt = { st0: 0x20 | (head << 2) | drv, pcn: ncn };
        this.intPending = true;
        this._enterCmdPhase();
    }

    _cmdSenseInterrupt() {
        if (!this.intPending) {
            this._enterResultPhase([0x80]);  // ST0 = invalid
            return;
        }
        this.intPending = false;
        const { st0, pcn } = this.lastInterrupt;
        this._enterResultPhase([st0, pcn]);
    }

    _cmdSenseDriveStatus() {
        const headDrive = this.cmdBuf[1];
        const drv = headDrive & 0x03;
        const head = (headDrive >> 2) & 1;
        const d = this.drives[drv];
        let st3 = (head << 2) | drv;
        if (d.disk) st3 |= 0x20;          // READY
        if (d.track === 0) st3 |= 0x10;   // TRACK 0
        // Double-sided is assumed for any inserted disk.
        if (d.disk) st3 |= 0x08;
        this._enterResultPhase([st3]);
    }

    _cmdReadData() {
        // Args (per spec):
        //   1: head/drive  2: C  3: H  4: R  5: N  6: EOT  7: GPL  8: DTL
        const headDrive = this.cmdBuf[1];
        const drv = headDrive & 0x03;
        const head = (headDrive >> 2) & 1;
        const c = this.cmdBuf[2];
        // const h_addr = this.cmdBuf[3];
        const r = this.cmdBuf[4];
        const d = this.drives[drv];
        if (!d.disk) {
            this._enterResultPhase([0x80, 0, 0, c, head, r, 0]);
            return;
        }
        const sec = d.disk.findSector(c, head, r);
        if (!sec) {
            // ST1 = 0x05 (Missing Address Mark + No Data).
            this._enterResultPhase([0x40, 0x05, 0, c, head, r, 0]);
            return;
        }
        // Enter execution phase: feed sec.data to host. Single-sector only —
        // multi-sector read (incrementing R up to EOT) is a future extension.
        this.execBuf = sec.data;
        this.execPos = 0;
        this.phase = 'exec-read';
        this.msr = MSR_RQM | MSR_DIO | MSR_EXM | MSR_CB;
        // Pre-build the result that will fire once execBuf is drained.
        this._pendingC = c;
        this._pendingH = head;
        this._pendingR = r;
        this._pendingN = sec.n;
        this._pendingDrive = drv;
    }

    _buildReadResult() {
        // ST0 = 0x00 (drive 0, head 0, normal termination); ST1 = ST2 = 0.
        const st0 = (this._pendingH << 2) | this._pendingDrive;
        return [st0, 0, 0, this._pendingC, this._pendingH, this._pendingR + 1, this._pendingN];
    }

    _enterResultPhase(bytes) {
        this.resultBuf = bytes;
        this.phase = 'result';
        this.msr = MSR_RQM | MSR_DIO | MSR_CB;
    }

    _enterCmdPhase() {
        this.cmdBuf = [];
        this.expectedCmdLen = 0;
        this.execBuf = null;
        this.phase = 'cmd';
        this.msr = MSR_RQM;
    }
}
