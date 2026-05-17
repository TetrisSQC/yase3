import pako from 'pako';

class ToneSegment {
    constructor(pulseLength, pulseCount) {
        this.pulseLength = pulseLength;
        this.pulseCount = pulseCount;
        this.pulsesGenerated = 0;
    }
    isFinished() {
        return this.pulsesGenerated == this.pulseCount;
    }
    getNextPulseLength() {
        this.pulsesGenerated++;
        return this.pulseLength;
    }
}

class PulseSequenceSegment {
    constructor(pulses) {
        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() {
        return this.index == this.pulses.length;
    }
    getNextPulseLength() {
        return this.pulses[this.index++];
    }
}

class DataSegment {
    constructor(data, zeroPulseLength, onePulseLength, lastByteBits) {
        this.data = data;
        this.zeroPulseLength = zeroPulseLength;
        this.onePulseLength = onePulseLength;
        this.bitCount = (this.data.length - 1) * 8 + lastByteBits;
        this.pulsesOutput = 0;
        this.lastPulseLength = null;
    }
    isFinished() {
        return this.pulsesOutput == this.bitCount * 2;
    }
    getNextPulseLength() {
        if (this.pulsesOutput & 0x01) {
            this.pulsesOutput++;
            return this.lastPulseLength;
        } else {
            const bitIndex = this.pulsesOutput >> 1;
            const byteIndex = bitIndex >> 3;
            const bitMask = 1 << (7 - (bitIndex & 0x07));
            this.lastPulseLength = (this.data[byteIndex] & bitMask) ? this.onePulseLength : this.zeroPulseLength;
            this.pulsesOutput++;
            return this.lastPulseLength;
        }
    }
}

/*
 * Pause segment.
 *
 * Per TZX 1.20 (e.g. block 0x10's spec): if the pause duration is non-zero
 * and the previous pulse was high, the loader needs to see a final 1ms
 * high pulse before the line drops low for the remainder of the pause.
 * Required by some loaders that detect end-of-block via the trailing edge.
 *
 * Implementation: PauseSegment emits up to three pulses. PulseGenerator
 * toggles 'level' before each, so we sometimes prepend a zero-length
 * "phase-adjusting" pulse to get the toggle to land on the desired level.
 * The generator reference passed into getNextPulseLength gives us access
 * to the current level so we can decide the right sequence at emission
 * time.
 */
class PauseSegment {
    constructor(duration) {
        this.duration = duration;  // in ms
        this.pulses = null;
        this.index = 0;
    }
    _buildPulses(generator) {
        const totalTstates = this.duration * 3500;
        // generator.level reflects the level of the most recently emitted
        // pulse. 0x8000 = high, 0x0000 = low.
        const wasHigh = (generator.level === 0x8000);
        const pulses = [];
        if (this.duration === 0) {
            // 0ms pause is "no pause" per spec, but produce an empty marker
            // pulse so the segment terminates cleanly.
            pulses.push(0);
        } else if (wasHigh) {
            // Already high: emit 1ms more high, then drop to low for the
            // remainder. PulseGenerator XORs level each emit, so to keep the
            // first pulse high we need to insert a zero-len pulse to flip
            // level low first, then the 1ms pulse flips it back high, then
            // the remainder flips low.
            const HIGH_TAIL = 3500;
            if (totalTstates <= HIGH_TAIL) {
                pulses.push(0, totalTstates);   // single high pulse
            } else {
                pulses.push(0, HIGH_TAIL, totalTstates - HIGH_TAIL);
            }
        } else {
            // Already low: stay low for the full pause. A single pulse here
            // would toggle the level to high, which we don't want. Insert a
            // zero-len pulse first so the toggle puts us back to low for the
            // emitted pulse.
            pulses.push(0, totalTstates);
        }
        return pulses;
    }
    isFinished() {
        return this.pulses !== null && this.index >= this.pulses.length;
    }
    getNextPulseLength(generator) {
        if (this.pulses === null) {
            this.pulses = this._buildPulses(generator);
        }
        return this.pulses[this.index++];
    }
}

/*
 * Direct Recording (TZX block 0x15).
 *
 * The sample stream is a run-length encoded square wave: each sample bit is
 * one logical state (1 = high, 0 = low) lasting tstatesPerSample T-states.
 * We run-length encode the bit stream into a sequence of pulse lengths so
 * PulseGenerator's natural toggle-on-each-pulse behavior reproduces the
 * square wave correctly. The pulse generator's initial level toggles on the
 * first pulse, so we prepend a zero-length pulse if the recording starts at
 * the opposite of the toggle-target level — matching the recording's initial
 * sample bit.
 */
class DirectRecordingSegment {
    constructor(data, tstatesPerSample, lastByteBits) {
        // Decode the recording into a list of pulse lengths (T-states each).
        const totalBits = (data.length - 1) * 8 + lastByteBits;
        const pulses = [];
        let curLevel = -1;
        let runLen = 0;
        for (let bitIndex = 0; bitIndex < totalBits; bitIndex++) {
            const byteIndex = bitIndex >> 3;
            const mask = 0x80 >> (bitIndex & 7);
            const bit = (data[byteIndex] & mask) ? 1 : 0;
            if (bit === curLevel) {
                runLen++;
            } else {
                if (runLen > 0) pulses.push(runLen * tstatesPerSample);
                curLevel = bit;
                runLen = 1;
            }
        }
        if (runLen > 0) pulses.push(runLen * tstatesPerSample);

        // Tell the generator to start in the level matching the first bit:
        // PulseGenerator toggles level *before* emitting a pulse, so if the
        // first sample bit is 1 (high) we want it to toggle 0 → 1, which is
        // the default. If the first bit is 0, prepend a zero-length pulse so
        // the toggle flips to 0.
        const firstByteBit = (data.length > 0) ? ((data[0] & 0x80) ? 1 : 0) : 0;
        if (firstByteBit === 0 && pulses.length > 0) {
            pulses.unshift(0);
        }

        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() {
        return this.index >= this.pulses.length;
    }
    getNextPulseLength() {
        return this.pulses[this.index++];
    }
}

/*
 * CSW Recording (TZX block 0x18).
 *
 * Header: sample rate u24, compression u8 (1=raw RLE, 2=Z-RLE),
 *         pulse-count u32, then RLE bytes.
 * Each byte b in the stream is a pulse-length in samples. b == 0 means the
 * next 4 bytes are a u32 length. The square wave starts low — pulses
 * alternate, which is the same default as PulseGenerator.
 *
 * For Z-RLE the body is zlib-compressed; we decompress with pako (already a
 * dependency for Z80 v2+ snapshots).
 */
class CswSegment {
    constructor(rawBytes, sampleRate, isCompressed) {
        let bytes = rawBytes;
        if (isCompressed) {
            bytes = pako.inflate(rawBytes);
        }
        // Convert each sample-count entry into a T-state length. The Spectrum
        // clock is 3.5 MHz; round to nearest.
        const tstatesPerSample = 3500000 / sampleRate;
        const pulses = [];
        let i = 0;
        while (i < bytes.length) {
            let samples = bytes[i++];
            if (samples === 0) {
                if (i + 4 > bytes.length) break;
                samples = bytes[i] | (bytes[i+1] << 8) | (bytes[i+2] << 16) | (bytes[i+3] << 24);
                i += 4;
            }
            pulses.push(Math.round(samples * tstatesPerSample));
        }
        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() { return this.index >= this.pulses.length; }
    getNextPulseLength() { return this.pulses[this.index++]; }
}

/*
 * Generalized Data (TZX block 0x19).
 *
 * Format (after the u32 block length and u16 pause, both consumed by the
 * outer parser):
 *
 *   TOTP u32  number of pilot/sync symbols (NB of PRLE pairs)
 *   NPP  u8   max number of pulses per pilot symbol
 *   ASP  u8   number of pilot symbols in the table (255 = 256)
 *   TOTD u32  number of data symbols
 *   NPD  u8   max pulses per data symbol
 *   ASD  u8   number of data symbols
 *   pilot symbol table:  ASP × ( flag-u8 + NPP × pulseLen-u16 )
 *   pilot stream:        TOTP × ( symId-u8 + count-u16 )
 *   data symbol table:   ASD × ( flag-u8 + NPD × pulseLen-u16 )
 *   data bit stream:     ceil(TOTD * bitsPerSymbol / 8) bytes
 *
 * Symbol flag (only bits 0..1 used):
 *   0 = pulse polarity is opposite of current
 *   1 = pulse polarity is same as current (i.e. start with same level)
 *   2 = force low
 *   3 = force high
 * A zero-length pulse in the symbol means "end of symbol".
 */
class GeneralizedDataSegment {
    /**
     * Pre-computed list of pulse lengths to emit. Built once by the parser.
     */
    constructor(pulses) {
        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() { return this.index >= this.pulses.length; }
    getNextPulseLength() { return this.pulses[this.index++]; }
}

/*
 * Decode a complete TZX 0x19 Generalized Data block into a flat list of
 * pulse-length T-states ready for emission via PulseGenerator. Returns an
 * array of integers.
 *
 * The pulse generator XORs its level on every emitted pulse. To match the
 * symbol-flag semantics (which can force start level or keep the previous
 * one), we insert zero-length "no-op" pulses between symbols where the
 * natural toggle would land on the wrong polarity.
 */
function buildGeneralizedPulses(view, offset, totp, npp, asp, totd, npd, asd) {
    let pos = offset;

    let pilotTable = null;
    if (totp > 0 && asp > 0) {
        const parsed = parseGeneralizedSymbolTable(view, pos, asp, npp);
        pilotTable = parsed.table;
        pos = parsed.endOffset;
    }
    const pilotStream = [];
    for (let p = 0; p < totp; p++) {
        const symId = view.getUint8(pos); pos += 1;
        const count = view.getUint16(pos, true); pos += 2;
        pilotStream.push({ symId, count });
    }

    let dataTable = null;
    let dataStreamStart = pos;
    if (totd > 0 && asd > 0) {
        const parsed = parseGeneralizedSymbolTable(view, pos, asd, npd);
        dataTable = parsed.table;
        dataStreamStart = parsed.endOffset;
    }

    const bitsPerSymbol = Math.max(1, Math.ceil(Math.log2(asd || 1)));
    const dataByteCount = Math.ceil(totd * bitsPerSymbol / 8);

    const pulses = [];
    let level = 0;

    if (pilotTable) {
        for (const entry of pilotStream) {
            const sym = pilotTable[entry.symId];
            for (let c = 0; c < entry.count; c++) {
                const { pulses: symPulses, endLevel } = expandGeneralizedSymbol(sym, level);
                for (const len of symPulses) pulses.push(len);
                level = endLevel;
            }
        }
    }

    if (dataTable && totd > 0) {
        // Read totd symbol-ids from the packed bit stream (MSB-first).
        let bitBuf = 0;
        let bitsAvail = 0;
        let bytePos = dataStreamStart;
        const fillBits = () => {
            while (bitsAvail < bitsPerSymbol) {
                if (bytePos >= dataStreamStart + dataByteCount) {
                    bitBuf <<= 8;
                    bitsAvail += 8;
                    continue;
                }
                bitBuf = (bitBuf << 8) | view.getUint8(bytePos++);
                bitsAvail += 8;
            }
        };
        for (let i = 0; i < totd; i++) {
            fillBits();
            const symId = (bitBuf >> (bitsAvail - bitsPerSymbol)) & ((1 << bitsPerSymbol) - 1);
            bitsAvail -= bitsPerSymbol;
            const sym = dataTable[symId];
            if (!sym) continue;
            const { pulses: symPulses, endLevel } = expandGeneralizedSymbol(sym, level);
            for (const len of symPulses) pulses.push(len);
            level = endLevel;
        }
    }

    return pulses;
}

function parseGeneralizedSymbolTable(view, base, symbolCount, pulsesPerSymbol) {
    const table = [];
    let pos = base;
    for (let s = 0; s < symbolCount; s++) {
        const flag = view.getUint8(pos++);
        const pulseLens = [];
        for (let p = 0; p < pulsesPerSymbol; p++) {
            pulseLens.push(view.getUint16(pos, true));
            pos += 2;
        }
        table.push({ flag, pulseLens });
    }
    return { table, endOffset: pos };
}

function expandGeneralizedSymbol(sym, currentLevel) {
    /* Returns { pulses, endLevel }. Pulses are tstate lengths; the caller is
     * responsible for level state since the symbol may force/start a level. */
    let startLevel;
    switch (sym.flag & 0x03) {
        case 0: startLevel = currentLevel ^ 1; break;
        case 1: startLevel = currentLevel;     break;
        case 2: startLevel = 0;                break;
        case 3: startLevel = 1;                break;
    }
    const pulses = [];
    for (const len of sym.pulseLens) {
        if (len === 0) break;  // end-of-symbol terminator
        pulses.push(len);
    }
    // Even number of pulses → returns to startLevel. Odd → flips.
    const endLevel = (pulses.length & 1) ? (startLevel ^ 1) : startLevel;
    // The caller emits these pulses as level toggles starting from
    // currentLevel. We need to insert a zero-length pulse if the natural
    // toggle target (currentLevel ^ 1) doesn't match startLevel.
    if (startLevel !== (currentLevel ^ 1)) {
        pulses.unshift(0);
    }
    return { pulses, endLevel };
}

class PulseGenerator {
    constructor(getSegments) {
        this.segments = [];
        this.getSegments = getSegments;
        this.level = 0x0000;
        this.tapeIsFinished = false;  // if true, don't call getSegments again
        this.pendingCycles = 0;
    }
    addSegment(segment) {
        this.segments.push(segment);
    }
    /**
     * Force the next pulse to start at this polarity. The PulseGenerator
     * normally toggles 'level' before emitting each pulse; setLevel arranges
     * the internal level so that the *next* toggle lands on `targetLevel`
     * (1 = high, 0 = low).
     *
     * Used by TZX 0x2B Set Signal Level. If called between blocks where no
     * pending pulse is in flight, the next pulse starts at exactly the
     * requested polarity.
     */
    setLevel(targetLevel) {
        // PulseGenerator toggles 'level' before emitting; we want the toggle
        // to produce targetLevel. So set level to NOT(targetLevel) shifted
        // into bit 15.
        this.level = targetLevel ? 0x0000 : 0x8000;
    }
    emitPulses(buffer, startIndex, cycleCount) {
        let cyclesEmitted = 0;
        let index = startIndex;
        let isFinished = false;
        while (cyclesEmitted < cycleCount) {
            if (this.pendingCycles > 0) {
                if (this.pendingCycles >= 0x8000) {
                    // emit a pulse of length 0x7fff
                    buffer[index++] = this.level | 0x7fff;
                    cyclesEmitted += 0x7fff;
                    this.pendingCycles -= 0x7fff;
                } else {
                    // emit a the remainder of this pulse in full
                    buffer[index++] = this.level | this.pendingCycles;
                    cyclesEmitted += this.pendingCycles;
                    this.pendingCycles = 0;
                }
            } else if (this.segments.length === 0) {
                if (this.tapeIsFinished) {
                    // mark end of tape
                    isFinished = true;
                    break;
                } else {
                    // get more segments
                    this.tapeIsFinished = !this.getSegments(this);
                }
            } else if (this.segments[0].isFinished()) {
                // discard finished segment
                this.segments.shift();
            } else {
                // new pulse — pass the generator in so segments that need
                // to inspect current level state (e.g. PauseSegment) can.
                this.pendingCycles = this.segments[0].getNextPulseLength(this);
                this.level ^= 0x8000;
            }
        }
        return [index, cyclesEmitted, isFinished];
    }
}

export class TAPFile {
    constructor(data) {
        let i = 0;
        this.blocks = [];
        var tap = new DataView(data);

        while ((i+1) < data.byteLength) {
            const blockLength = tap.getUint16(i, true);
            i += 2;
            this.blocks.push(new Uint8Array(data, i, blockLength));
            i += blockLength;
        }

        this.nextBlockIndex = 0;

        this.pulseGenerator = new PulseGenerator((generator) => {
            if (this.blocks.length === 0) return false;
            const block = this.blocks[this.nextBlockIndex];
            this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;

            if (block[0] & 0x80) {
                // add short leader tone for data block
                generator.addSegment(new ToneSegment(2168, 3223));
            } else {
                // add long leader tone for header block
                generator.addSegment(new ToneSegment(2168, 8063));
            }
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block, 855, 1710, 8));
            generator.addSegment(new PauseSegment(1000));

            // return false if tape has ended
            return this.nextBlockIndex != 0;
        });
    }

    getNextLoadableBlock() {
        if (this.blocks.length === 0) return null;
        const block = this.blocks[this.nextBlockIndex];
        this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;
        return block;
    }

    static isValid(data) {
        /* test whether the given ArrayBuffer is a valid TAP file, i.e. EOF is consistent with the
        block lengths we read from the file */
        let pos = 0;
        const tap = new DataView(data);

        while (pos < data.byteLength) {
            if (pos + 1 >= data.byteLength) return false; /* EOF in the middle of a length word */
            const blockLength = tap.getUint16(pos, true);
            pos += blockLength + 2;
        }

        return (pos == data.byteLength); /* file is a valid TAP if pos is exactly at EOF and no further */
    }
};


export class TZXFile {
    static isValid(data) {
        const tzx = new DataView(data);

        const signature = "ZXTape!\x1A";
        for (let i = 0; i < signature.length; i++) {
            if (signature.charCodeAt(i) != tzx.getUint8(i)) {
                return false;
            }
        }
        return true;
    }

    constructor(data) {
        this.blocks = [];
        const tzx = new DataView(data);

        let offset = 0x0a;

        while (offset < data.byteLength) {
            const blockType = tzx.getUint8(offset);
            offset++;
            switch (blockType) {
                case 0x10:
                    (() => {
                        const pause = tzx.getUint16(offset, true);
                        offset += 2;
                        const dataLength = tzx.getUint16(offset, true);
                        offset += 2;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'StandardSpeedData',
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                if (blockData[0] & 0x80) {
                                    // add short leader tone for data block
                                    generator.addSegment(new ToneSegment(2168, 3223));
                                } else {
                                    // add long leader tone for header block
                                    generator.addSegment(new ToneSegment(2168, 8063));
                                }
                                generator.addSegment(new PulseSequenceSegment([667, 735]));
                                generator.addSegment(new DataSegment(blockData, 855, 1710, 8));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x11:
                    (() => {
                        const pilotPulseLength = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse1Length = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse2Length = tzx.getUint16(offset, true); offset += 2;
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const pilotPulseCount = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'TurboSpeedData',
                            'pilotPulseLength': pilotPulseLength,
                            'syncPulse1Length': syncPulse1Length,
                            'syncPulse2Length': syncPulse2Length,
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'pilotPulseCount': pilotPulseCount,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pilotPulseLength, pilotPulseCount));
                                generator.addSegment(new PulseSequenceSegment([syncPulse1Length, syncPulse2Length]));
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x12:
                    (() => {
                        const pulseLength = tzx.getUint16(offset, true); offset += 2;
                        const pulseCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'PureTone',
                            'pulseLength': pulseLength,
                            'pulseCount': pulseCount,
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pulseLength, pulseCount));
                            }
                        });
                    })();
                    break;
                case 0x13:
                    (() => {
                        const pulseCount = tzx.getUint8(offset); offset += 1;
                        const pulseLengths = [];
                        for (let i = 0; i < pulseCount; i++) {
                            pulseLengths[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'PulseSequence',
                            'pulseLengths': pulseLengths,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PulseSequenceSegment(pulseLengths));
                            }
                        });
                        offset += (pulseCount * 2);
                    })();
                    break;
                case 0x14:
                    (() => {
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'PureData',
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x15:
                    (() => {
                        const tstatesPerSample = tzx.getUint16(offset, true); offset += 2;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const lastByteBits = tzx.getUint8(offset); offset += 1;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'DirectRecording',
                            'tstatesPerSample': tstatesPerSample,
                            'lastByteBits': lastByteBits,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new DirectRecordingSegment(blockData, tstatesPerSample, lastByteBits));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x18:
                    (() => {
                        const blockLength = tzx.getUint32(offset, true); offset += 4;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const sampleRate = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const compression = tzx.getUint8(offset); offset += 1;
                        offset += 4;  // skip pulse count u32 (we count from the bytes)
                        const cswBytes = new Uint8Array(data, offset, blockLength - 10);
                        this.blocks.push({
                            'type': 'CswRecording',
                            'sampleRate': sampleRate,
                            'compression': compression,
                            'pause': pause,
                            'data': cswBytes,
                            'generatePulses': (generator) => {
                                generator.addSegment(new CswSegment(cswBytes, sampleRate, compression === 2));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += blockLength - 10;
                    })();
                    break;
                case 0x19:
                    (() => {
                        const blockLength = tzx.getUint32(offset, true); offset += 4;
                        const blockEnd = offset + blockLength;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const totp = tzx.getUint32(offset, true); offset += 4;
                        const npp = tzx.getUint8(offset); offset += 1;
                        let asp = tzx.getUint8(offset); offset += 1;
                        if (asp === 0) asp = 256;
                        const totd = tzx.getUint32(offset, true); offset += 4;
                        const npd = tzx.getUint8(offset); offset += 1;
                        let asd = tzx.getUint8(offset); offset += 1;
                        if (asd === 0) asd = 256;

                        // Build the actual T-state pulse list eagerly so the
                        // segment is trivial at playback time.
                        const pulses = buildGeneralizedPulses(
                            tzx, offset, totp, npp, asp, totd, npd, asd
                        );

                        offset = blockEnd;
                        this.blocks.push({
                            'type': 'GeneralizedData',
                            'pause': pause,
                            'generatePulses': (generator) => {
                                generator.addSegment(new GeneralizedDataSegment(pulses));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x20:
                    (() => {
                        // TODO: handle pause length of 0 (= stop tape)
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'Pause',
                            'pause': pause,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x21:
                    (() => {
                        const nameLength = tzx.getUint8(offset); offset += 1;
                        const nameBytes = new Uint8Array(data, offset, nameLength);
                        offset += nameLength;
                        const name = String.fromCharCode.apply(null, nameBytes);
                        this.blocks.push({
                            'type': 'GroupStart',
                            'name': name
                        });
                    })();
                    break;
                case 0x22:
                    (() => {
                        this.blocks.push({
                            'type': 'GroupEnd'
                        });
                    })();
                    break;
                case 0x23:
                    (() => {
                        const jumpOffset = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'JumpToBlock',
                            'offset': jumpOffset
                        });
                    })();
                    break;
                case 0x24:
                    (() => {
                        const repeatCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'LoopStart',
                            'repeatCount': repeatCount
                        });
                    })();
                    break;
                case 0x25:
                    (() => {
                        this.blocks.push({
                            'type': 'LoopEnd'
                        });
                    })();
                    break;
                case 0x26:
                    (() => {
                        const callCount = tzx.getUint16(offset, true); offset += 2;
                        const offsets = [];
                        for (let i = 0; i < callCount; i++) {
                            offsets[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'CallSequence',
                            'offsets': offsets
                        });
                        offset += (callCount * 2);
                    })();
                    break;
                case 0x27:
                    (() => {
                        this.blocks.push({
                            'type': 'ReturnFromSequence'
                        });
                    })();
                    break;
                case 0x28:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        /* This is a silly block. Don't bother parsing it further. */
                        this.blocks.push({
                            'type': 'Select',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x2A:
                    (() => {
                        offset += 4;  // u32 block length, always 0
                        this.blocks.push({
                            'type': 'StopTapeIf48k',
                            'generatePulses': () => {
                                // Effective in 48K mode only. The PulseGenerator's
                                // getSegments-callback layer handles the actual stop
                                // by checking TZXFile.machineType when this block is
                                // yielded — see getNextMeaningfulBlock.
                            }
                        });
                    })();
                    break;
                case 0x2B:
                    (() => {
                        const blockLength = tzx.getUint32(offset, true); offset += 4;
                        const newLevel = tzx.getUint8(offset); offset += 1;
                        offset += blockLength - 1;
                        this.blocks.push({
                            'type': 'SetSignalLevel',
                            'level': newLevel ? 1 : 0,
                            'generatePulses': (generator) => {
                                generator.setLevel(newLevel ? 1 : 0);
                            }
                        });
                    })();
                    break;
                case 0x30:
                    (() => {
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'TextDescription',
                            'text': text
                        });
                    })();
                    break;
                case 0x31:
                    (() => {
                        const displayTime = tzx.getUint8(offset); offset += 1;
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'MessageBlock',
                            'displayTime': displayTime,
                            'text': text
                        });
                    })();
                    break;
                case 0x32:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'ArchiveInfo',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x33:
                    (() => {
                        const blockLength = tzx.getUint8(offset) * 3; offset += 1;
                        this.blocks.push({
                            'type': 'HardwareType',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x35:
                    (() => {
                        const identifierBytes = new Uint8Array(data, offset, 10);
                        offset += 10;
                        const identifier = String.fromCharCode.apply(null, identifierBytes);
                        const dataLength = tzx.getUint32(offset, true);
                        this.blocks.push({
                            'type': 'CustomInfo',
                            'identifier': identifier,
                            'data': new Uint8Array(data, offset, dataLength)
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x5A:
                    (() => {
                        offset += 9;
                        this.blocks.push({
                            'type': 'Glue'
                        });
                    })();
                    break;
                default:
                    (() => {
                        /* follow extension rule: next 4 bytes = length of block */
                        const blockLength = tzx.getUint32(offset, true);
                        offset += 4;
                        this.blocks.push({
                            'type': 'unknown',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                }
        }

        this.nextBlockIndex = 0;
        this.loopToBlockIndex;
        this.repeatCount;
        this.callStack = [];
        // Set externally (e.g. by worker on machine select). Used by 0x2A
        // (Stop Tape If In 48K Mode) to decide whether to halt playback.
        this.machineType = null;

        this.pulseGenerator = new PulseGenerator((generator) => {
            const block = this.getNextMeaningfulBlock(false);
            if (!block) return false;
            if (block.type === 'StopTapeIf48k' && this.machineType === 48) {
                return false;
            }
            block.generatePulses(generator);
            return true;
        });
    }

    /** Sets the machine type so 0x2A blocks can react correctly. */
    setMachineType(type) {
        this.machineType = type;
    }

    getNextMeaningfulBlock(wrapAtEnd) {
        let startedAtZero = (this.nextBlockIndex === 0);
        while (true) {
            if (this.nextBlockIndex >= this.blocks.length) {
                if (startedAtZero || !wrapAtEnd) return null; /* have looped around; quit now */
                this.nextBlockIndex = 0;
                startedAtZero = true;
            }
            var block = this.blocks[this.nextBlockIndex];
            switch (block.type) {
                case 'StandardSpeedData':
                case 'TurboSpeedData':
                case 'PureTone':
                case 'PulseSequence':
                case 'PureData':
                case 'DirectRecording':
                case 'CswRecording':
                case 'GeneralizedData':
                case 'Pause':
                case 'StopTapeIf48k':
                case 'SetSignalLevel':
                    /* found a meaningful block */
                    this.nextBlockIndex++;
                    return block;
                case 'JumpToBlock':
                    this.nextBlockIndex += block.offset;
                    break;
                case 'LoopStart':
                    this.loopToBlockIndex = this.nextBlockIndex + 1;
                    this.repeatCount = block.repeatCount;
                    this.nextBlockIndex++;
                    break;
                case 'LoopEnd':
                    this.repeatCount--;
                    if (this.repeatCount > 0) {
                        this.nextBlockIndex = this.loopToBlockIndex;
                    } else {
                        this.nextBlockIndex++;
                    }
                    break;
                case 'CallSequence':
                    /* push the future destinations (where to go on reaching a ReturnFromSequence block)
                        onto the call stack in reverse order, starting with the block immediately
                        after the CallSequence (which we go to when leaving the sequence) */
                    this.callStack.unshift(this.nextBlockIndex+1);
                    for (var i = block.offsets.length - 1; i >= 0; i--) {
                        this.callStack.unshift(this.nextBlockIndex + block.offsets[i]);
                    }
                    /* now visit the first destination on the list */
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                case 'ReturnFromSequence':
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                default:
                    /* not one of the types we care about; skip past it */
                    this.nextBlockIndex++;
            }
        }
    }

    getNextLoadableBlock() {
        while (true) {
            var block = this.getNextMeaningfulBlock(true);
            if (!block) return null;
            if (block.type == 'StandardSpeedData' || block.type == 'TurboSpeedData') {
                return block.data;
            }
            /* FIXME: avoid infinite loop if the TZX file consists only of meaningful but non-loadable blocks */
        }
    }
};
