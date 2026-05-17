/*
 * Minimal Z80 disassembler. Covers the unprefixed opcodes plus the most
 * common DD/FD/ED/CB prefixes. Returns { text, length } for the
 * instruction at the given address.
 *
 * Not a complete reference disassembler — sufficient for stepping through
 * typical 48K BASIC ROM and game loops. Unknown opcodes are rendered as
 * raw bytes (`DB nn`) so disassembly always advances by at least one byte.
 */

const R8  = ['B','C','D','E','H','L','(HL)','A'];
const RP  = ['BC','DE','HL','SP'];
const RPA = ['BC','DE','HL','AF'];
const CC  = ['NZ','Z','NC','C','PO','PE','P','M'];
const ALU = [
    (s) => `ADD A,${s}`, (s) => `ADC A,${s}`,
    (s) => `SUB ${s}`,   (s) => `SBC A,${s}`,
    (s) => `AND ${s}`,   (s) => `XOR ${s}`,
    (s) => `OR ${s}`,    (s) => `CP ${s}`,
];
const ROT = ['RLC','RRC','RL','RR','SLA','SRA','SLL','SRL'];

const hex2 = (b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase();
const hex4 = (w) => (w & 0xffff).toString(16).padStart(4, '0').toUpperCase();

export function disasm(memReader, addr) {
    const start = addr & 0xffff;
    let pc = start;
    const get = () => memReader(pc++ & 0xffff);
    const get16 = () => { const lo = get(); const hi = get(); return lo | (hi << 8); };
    const sd = (b) => (b < 0x80 ? b : b - 0x100);
    const disp = () => {
        const d = sd(get());
        const tgt = (pc + d) & 0xffff;
        return { d, tgt };
    };

    let text;
    const op = get();

    // ------ CB-prefix ------
    if (op === 0xcb) {
        const cb = get();
        const r = R8[cb & 7];
        const bit = (cb >> 3) & 7;
        if (cb < 0x40) text = `${ROT[bit]} ${r}`;
        else if (cb < 0x80) text = `BIT ${bit},${r}`;
        else if (cb < 0xc0) text = `RES ${bit},${r}`;
        else                text = `SET ${bit},${r}`;
    }
    // ------ ED-prefix ------
    else if (op === 0xed) {
        const ed = get();
        const ed_table = {
            0x40:'IN B,(C)', 0x41:'OUT (C),B', 0x42:'SBC HL,BC', 0x43:'',
            0x44:'NEG',      0x45:'RETN',      0x46:'IM 0',      0x47:'LD I,A',
            0x48:'IN C,(C)', 0x49:'OUT (C),C', 0x4a:'ADC HL,BC', 0x4b:'',
            0x4d:'RETI',     0x4f:'LD R,A',
            0x50:'IN D,(C)', 0x51:'OUT (C),D', 0x52:'SBC HL,DE', 0x53:'',
            0x56:'IM 1',     0x57:'LD A,I',
            0x58:'IN E,(C)', 0x59:'OUT (C),E', 0x5a:'ADC HL,DE', 0x5b:'',
            0x5e:'IM 2',     0x5f:'LD A,R',
            0x60:'IN H,(C)', 0x61:'OUT (C),H', 0x62:'SBC HL,HL', 0x67:'RRD',
            0x68:'IN L,(C)', 0x69:'OUT (C),L', 0x6a:'ADC HL,HL', 0x6f:'RLD',
            0x72:'SBC HL,SP', 0x73:'',
            0x78:'IN A,(C)', 0x79:'OUT (C),A', 0x7a:'ADC HL,SP', 0x7b:'',
            0xa0:'LDI', 0xa1:'CPI', 0xa2:'INI', 0xa3:'OUTI',
            0xa8:'LDD', 0xa9:'CPD', 0xaa:'IND', 0xab:'OUTD',
            0xb0:'LDIR', 0xb1:'CPIR', 0xb2:'INIR', 0xb3:'OTIR',
            0xb8:'LDDR', 0xb9:'CPDR', 0xba:'INDR', 0xbb:'OTDR',
        };
        if (ed === 0x43) text = `LD (${hex4(get16())}H),BC`;
        else if (ed === 0x4b) text = `LD BC,(${hex4(get16())}H)`;
        else if (ed === 0x53) text = `LD (${hex4(get16())}H),DE`;
        else if (ed === 0x5b) text = `LD DE,(${hex4(get16())}H)`;
        else if (ed === 0x73) text = `LD (${hex4(get16())}H),SP`;
        else if (ed === 0x7b) text = `LD SP,(${hex4(get16())}H)`;
        else text = ed_table[ed] ?? `DB ED,${hex2(ed)}H`;
    }
    // ------ DD / FD prefix (IX/IY) ------
    else if (op === 0xdd || op === 0xfd) {
        const ix = (op === 0xdd) ? 'IX' : 'IY';
        const sub = get();
        if (sub === 0xcb) {
            const d = sd(get());
            const cb = get();
            const r = R8[cb & 7];
            const bit = (cb >> 3) & 7;
            const ref = `(${ix}${d >= 0 ? '+' : ''}${d})`;
            if (cb < 0x40) text = `${ROT[bit]} ${ref}`;
            else if (cb < 0x80) text = `BIT ${bit},${ref}`;
            else if (cb < 0xc0) text = `RES ${bit},${ref}`;
            else                text = `SET ${bit},${ref}`;
        } else {
            // Re-use the base disassembly path but substitute HL→IX/IY and
            // (HL) → (IX+d)/(IY+d). Easiest is a small inline lookup.
            text = disasmIxIy(ix, sub, get, sd);
        }
    }
    else {
        text = disasmBase(op, get, get16, sd, disp);
    }

    return { text, length: (pc - start + 0x10000) & 0xffff };
}

function disasmIxIy(ix, op, get, sd) {
    // Many DD/FD opcodes mirror the base table but with HL→ix and (HL)→(ix+d).
    // Cover the frequently-used subset.
    const dlit = () => {
        const d = sd(get());
        return `(${ix}${d >= 0 ? '+' : ''}${d})`;
    };
    if (op === 0x21) {
        const lo = get(); const hi = get();
        return `LD ${ix},${hex4(lo | (hi << 8))}H`;
    }
    if (op === 0x22) return `LD (${hex4(getU16(get))}H),${ix}`;
    if (op === 0x2a) return `LD ${ix},(${hex4(getU16(get))}H)`;
    if (op === 0x23) return `INC ${ix}`;
    if (op === 0x2b) return `DEC ${ix}`;
    if (op === 0x36) {
        const ref = dlit();
        const n = get();
        return `LD ${ref},${hex2(n)}H`;
    }
    if (op === 0xe1) return `POP ${ix}`;
    if (op === 0xe5) return `PUSH ${ix}`;
    if (op === 0xe9) return `JP (${ix})`;
    // LD r,(IX+d) family: 0x46/0x4e/0x56/0x5e/0x66/0x6e/0x7e
    const ldRefDst = { 0x46:'B', 0x4e:'C', 0x56:'D', 0x5e:'E', 0x66:'H', 0x6e:'L', 0x7e:'A' };
    if (ldRefDst[op]) return `LD ${ldRefDst[op]},${dlit()}`;
    // LD (IX+d),r family: 0x70..0x77 (excluding 0x76 = HALT)
    const ldRefSrc = { 0x70:'B', 0x71:'C', 0x72:'D', 0x73:'E', 0x74:'H', 0x75:'L', 0x77:'A' };
    if (ldRefSrc[op]) return `LD ${dlit()},${ldRefSrc[op]}`;
    // ALU A,(IX+d): 0x86, 0x8e, 0x96, 0x9e, 0xa6, 0xae, 0xb6, 0xbe
    const aluTable = { 0x86:'ADD A,', 0x8e:'ADC A,', 0x96:'SUB ', 0x9e:'SBC A,',
                       0xa6:'AND ', 0xae:'XOR ', 0xb6:'OR ', 0xbe:'CP ' };
    if (aluTable[op]) return aluTable[op] + dlit();
    if (op === 0x34) return `INC ${dlit()}`;
    if (op === 0x35) return `DEC ${dlit()}`;
    return `DB ${ix === 'IX' ? 'DD' : 'FD'},${hex2(op)}H`;
}
function getU16(get) { const lo = get(); const hi = get(); return lo | (hi << 8); }

function disasmBase(op, get, get16, sd, disp) {
    // 8-bit LD r,r' family — 0x40..0x7f, but 0x76 = HALT.
    if (op >= 0x40 && op < 0x80) {
        if (op === 0x76) return 'HALT';
        const dst = R8[(op >> 3) & 7];
        const src = R8[op & 7];
        return `LD ${dst},${src}`;
    }
    // ALU A,r 0x80..0xbf
    if (op >= 0x80 && op < 0xc0) {
        const alu = ALU[(op >> 3) & 7];
        return alu(R8[op & 7]);
    }
    // ALU A,n — 0xc6/0xce/0xd6/0xde/0xe6/0xee/0xf6/0xfe
    if ((op & 0xc7) === 0xc6) {
        const alu = ALU[(op >> 3) & 7];
        return alu(`${hex2(get())}H`);
    }
    // INC r (0x04..0x3c step 8) / DEC r (0x05..0x3d step 8)
    if ((op & 0xc7) === 0x04) return `INC ${R8[(op >> 3) & 7]}`;
    if ((op & 0xc7) === 0x05) return `DEC ${R8[(op >> 3) & 7]}`;
    // LD r,n — 0x06/0x0e/0x16/0x1e/0x26/0x2e/0x36/0x3e
    if ((op & 0xc7) === 0x06) return `LD ${R8[(op >> 3) & 7]},${hex2(get())}H`;
    // LD rp,nn  — 0x01/0x11/0x21/0x31
    if ((op & 0xcf) === 0x01) return `LD ${RP[(op >> 4) & 3]},${hex4(get16())}H`;
    // INC rp / DEC rp
    if ((op & 0xcf) === 0x03) return `INC ${RP[(op >> 4) & 3]}`;
    if ((op & 0xcf) === 0x0b) return `DEC ${RP[(op >> 4) & 3]}`;
    // ADD HL,rp
    if ((op & 0xcf) === 0x09) return `ADD HL,${RP[(op >> 4) & 3]}`;
    // PUSH rp2 / POP rp2
    if ((op & 0xcf) === 0xc5) return `PUSH ${RPA[(op >> 4) & 3]}`;
    if ((op & 0xcf) === 0xc1) return `POP ${RPA[(op >> 4) & 3]}`;
    // RET cc / JP cc,nn / CALL cc,nn
    if ((op & 0xc7) === 0xc0) return `RET ${CC[(op >> 3) & 7]}`;
    if ((op & 0xc7) === 0xc2) return `JP ${CC[(op >> 3) & 7]},${hex4(get16())}H`;
    if ((op & 0xc7) === 0xc4) return `CALL ${CC[(op >> 3) & 7]},${hex4(get16())}H`;
    // RST n
    if ((op & 0xc7) === 0xc7) return `RST ${hex2(op & 0x38)}H`;
    // JR / DJNZ
    if (op === 0x10) { const { tgt } = disp(); return `DJNZ ${hex4(tgt)}H`; }
    if (op === 0x18) { const { tgt } = disp(); return `JR ${hex4(tgt)}H`; }
    if ((op & 0xe7) === 0x20) {
        const { tgt } = disp();
        return `JR ${CC[(op >> 3) & 3]},${hex4(tgt)}H`;
    }
    // Misc one-byte
    const misc = {
        0x00:'NOP', 0x02:'LD (BC),A', 0x07:'RLCA', 0x08:"EX AF,AF'", 0x0a:'LD A,(BC)', 0x0f:'RRCA',
        0x12:'LD (DE),A', 0x17:'RLA', 0x1a:'LD A,(DE)', 0x1f:'RRA',
        0x27:'DAA', 0x2f:'CPL', 0x37:'SCF', 0x3f:'CCF',
        0xc3:`JP`, 0xc9:'RET', 0xcd:'CALL', 0xd9:'EXX', 0xe3:'EX (SP),HL', 0xe9:'JP (HL)',
        0xeb:'EX DE,HL', 0xf3:'DI', 0xf9:'LD SP,HL', 0xfb:'EI',
        0xd3:'OUT (n),A', 0xdb:'IN A,(n)',
    };
    if (op === 0x22) return `LD (${hex4(get16())}H),HL`;
    if (op === 0x2a) return `LD HL,(${hex4(get16())}H)`;
    if (op === 0x32) return `LD (${hex4(get16())}H),A`;
    if (op === 0x3a) return `LD A,(${hex4(get16())}H)`;
    if (op === 0xc3) return `JP ${hex4(get16())}H`;
    if (op === 0xcd) return `CALL ${hex4(get16())}H`;
    if (op === 0xd3) return `OUT (${hex2(get())}H),A`;
    if (op === 0xdb) return `IN A,(${hex2(get())}H)`;
    return misc[op] ?? `DB ${hex2(op)}H`;
}
