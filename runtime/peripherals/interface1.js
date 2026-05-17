/*
 * Sinclair Interface 1 + Microdrive emulation.
 *
 * Ported (with simplifications) from Fuse 1.8.0 peripherals/if1.c.
 *
 * Hardware:
 *   - 8 KB shadow ROM mapped to 0x0000-0x1FFF via /ROMCS when paged in
 *     (M1 hook in wasm core handles the page-in/out)
 *   - 8 microdrives (M1..M8) accessed through three ULA ports
 *   - RS-232 and SinclairNET are stubbed
 *
 * Ports (mask 0x0018):
 *   bits 4:3 = 00 → MDR  data port  (read/write microdrive byte stream)
 *   bits 4:3 = 01 → CTR  control    (write: motor/clk/data; read: status)
 *   bits 4:3 = 10 → NET  RS232/Net  (read 0xff, write ignored)
 *
 * Microdrive state per drive: inserted, motor, head position, current
 * data byte counter, preamble/sync state, full 543×254 cartridge image.
 *
 * NB: the bit-level emulation we provide is the practical subset that
 * the IF1 ROM uses — sufficient for SAVE/LOAD/FORMAT/CAT
 * commands to recognise sectors and read/write bytes. Real-time motor
 * spin is approximated by advancing head_pos one byte per port access.
 */

import { MDR_CART_SIZE } from '../disk/mdr.js';

const IF1_SLOT = 86;        // wasm machineMemory slot for the 8 K IF1 ROM
const ROM_SIZE = 0x2000;
const SECTOR_LEN = 543;
const NUM_SECTORS = 254;

const PORT_MDR = 0;
const PORT_CTR = 1;
const PORT_NET = 2;

function newMicrodrive() {
    return {
        inserted: false,
        writeProtect: false,
        motorOn: false,
        headPos: 0,
        transferred: 0,
        maxBytes: 15,
        last: 0, gap: 0xff, sync: 0xff,
        preamble: new Uint8Array(512),
        cartridge: null,        // Uint8Array(CART_SIZE) or null
        modified: false,
    };
}

const SYNC_OK = 0xfe;

export function createInterface1({ core, memoryData, romBytes }) {
    const drives = Array.from({ length: 8 }, () => newMicrodrive());
    const ula = {
        commsClk: 0, commsData: 0, wait: 0, busy: 0,
        countIn: 0, dataIn: 0, countOut: 0, dataOut: 0,
    };

    // Pre-fill the IF1 ROM slot once on attach.
    function syncRom() {
        const base = core.MACHINE_MEMORY + IF1_SLOT * 0x4000;
        // Pad to 16 K — only first 8 K is used when paged in.
        memoryData.fill(0xff, base, base + 0x4000);
        memoryData.set(romBytes.subarray(0, ROM_SIZE), base);
        memoryData.set(romBytes.subarray(0, ROM_SIZE), base + ROM_SIZE);   // mirror in upper 8K
    }

    function decodePort(port) {
        switch (port & 0x0018) {
            case 0x0000: return PORT_MDR;
            case 0x0008: return PORT_CTR;
            case 0x0010: return PORT_NET;
            default:     return -1;
        }
    }

    function incrementHead(m) {
        const d = drives[m];
        d.headPos = (d.headPos + 1) % MDR_CART_SIZE;
        d.transferred = (d.transferred + 1) % MDR_CART_SIZE;
    }

    function mdrIn() {
        let result = 0xff;
        for (let m = 0; m < 8; m++) {
            const d = drives[m];
            if (!d.motorOn || !d.inserted || !d.cartridge) continue;
            const block = (d.headPos / SECTOR_LEN) | 0;
            if (d.preamble[block] === SYNC_OK) {
                if (d.transferred < 15 + 3 || (d.transferred > 27 && d.transferred < 543)) {
                    result &= d.cartridge[d.headPos];
                }
                incrementHead(m);
            } else {
                // searching for preamble — advance and feed zeros
                incrementHead(m);
            }
            d.maxBytes = (d.transferred < 15) ? 15 : 527;
        }
        return result;
    }

    function mdrOut(val) {
        for (let m = 0; m < 8; m++) {
            const d = drives[m];
            if (!d.motorOn || !d.inserted || !d.cartridge) continue;
            const block = (d.headPos / SECTOR_LEN) | 0
                          + (d.maxBytes === 15 ? 0 : 256);
            if (d.transferred === 0 && val === 0x00) d.preamble[block] = 1;
            else if (d.transferred > 0 && d.transferred < 10 && val === 0x00) d.preamble[block]++;
            else if (d.transferred > 9 && d.transferred < 12 && val === 0xff) d.preamble[block]++;
            else if (d.transferred === 12 && d.preamble[block] === 12) d.preamble[block] = SYNC_OK;

            if (d.transferred > 11 && d.transferred < d.maxBytes + 12 && !d.writeProtect) {
                d.cartridge[d.headPos] = val;
                d.modified = true;
                incrementHead(m);
            } else {
                incrementHead(m);
            }
        }
    }

    function ctrIn() {
        // Status register read. Bit 7 = busy (always 0), bit 4 = DTR (1),
        // bit 3 = gap, bit 2 = sync, bit 1 = WPR.
        let status = 0xff;
        let active = null;
        for (let m = 0; m < 8; m++) if (drives[m].motorOn) { active = drives[m]; break; }
        if (active) {
            if (active.writeProtect) status &= ~0x01;
            const block = (active.headPos / SECTOR_LEN) | 0;
            if (active.preamble[block] === SYNC_OK) status &= ~(0x08 | 0x04);
        }
        return status;
    }

    function ctrOut(val) {
        // Bit 0 = data, bit 1 = clk. On falling edge of clk shift the
        // motor-on state down the chain. Top drive gets fed by bit 0
        // (inverted). Simplified: only the basic motor selection.
        if (!(val & 0x02) && ula.commsClk) {
            for (let m = 7; m > 0; m--) drives[m].motorOn = drives[m - 1].motorOn;
            drives[0].motorOn = (val & 0x01) ? false : true;
            // Reset transferred counter on motor select change so the
            // next sector read starts fresh.
            for (let m = 0; m < 8; m++) if (drives[m].motorOn) drives[m].transferred = 0;
        }
        ula.commsData = (val & 0x01) ? 1 : 0;
        ula.commsClk  = (val & 0x02) ? 1 : 0;
        ula.wait      = (val & 0x20) ? 1 : 0;
    }

    function netIn()  { return 0xff; }      // RS-232/Network stubs
    function netOut(_val) { /* ignored */ }

    syncRom();

    return {
        type: 'interface1',
        ports: [
            { mask: 0x0018, match: 0x0000,
              read:  () => mdrIn(),
              write: (_p, v) => mdrOut(v) },
            { mask: 0x0018, match: 0x0008,
              read:  () => ctrIn(),
              write: (_p, v) => ctrOut(v) },
            { mask: 0x0018, match: 0x0010,
              read:  () => netIn(),
              write: (_p, v) => netOut(v) },
        ],

        insertMicrodrive(idx, mdr) {
            if (idx < 0 || idx > 7) return;
            const d = drives[idx];
            d.cartridge = mdr.data;
            d.writeProtect = !!mdr.writeProtect;
            d.inserted = true;
            d.headPos = 0;
            d.transferred = 0;
            d.preamble.fill(0);
            d.modified = false;
        },
        ejectMicrodrive(idx) {
            if (idx < 0 || idx > 7) return;
            const d = drives[idx];
            d.cartridge = null;
            d.inserted = false;
            d.motorOn = false;
        },
        getCartridge(idx) {
            const d = drives[idx];
            return d.inserted ? { data: d.cartridge, writeProtect: d.writeProtect, modified: d.modified } : null;
        },
        drives,
        ula,
        reset() {
            for (const d of drives) {
                d.motorOn = false;
                d.headPos = 0;
                d.transferred = 0;
                d.preamble.fill(0);
            }
            ula.commsClk = ula.commsData = ula.wait = 0;
            // Tell wasm where the ROM lives.
            if (core.setIF1) core.setIF1(1, IF1_SLOT);
            syncRom();
        },
        detach() {
            if (core.setIF1) core.setIF1(0, 0);
        },
    };
}

export const IF1_ROM_SLOT = IF1_SLOT;
