/*
 * OSD-style Z80 debugger widget. Renders in the OSD canvas in the same
 * aesthetic as the menu.
 *
 * Keys:
 *   F10           Step one instruction
 *   F5 / Esc      Continue (close debugger, resume)
 *   F8            Reset machine
 *   F9 / b        Toggle breakpoint at the highlighted address
 *   p             Poke a byte at the highlighted address (prompt)
 *   c             Clear all breakpoints
 *   ↑ / ↓         Move cursor through the disassembly window
 *   Home          Reset cursor to PC
 */

import { COLOUR } from '../render.js';
import { disasm } from '../../debugger/disasm.js';

const REG_NAMES = ['AF','BC','DE','HL',"AF'","BC'","DE'","HL'",'IX','IY','SP','IR'];

const hex2 = (b) => (b & 0xff).toString(16).padStart(2,'0').toUpperCase();
const hex4 = (w) => (w & 0xffff).toString(16).padStart(4,'0').toUpperCase();

export class DebuggerWidget {
    constructor(emu) {
        this.emu = emu;
        this.osd = null;
        this.state = null;
        this.cursorRow = 0;                  // index 0..15 in current disasm list
        this.disasmAddrs = [];               // addresses of the 16 rendered rows

        this._workerListener = (e) => {
            const m = e.data?.message;
            if (m === 'debugSnapshot') {
                this.state = e.data;
                this.osd?.redraw();
            } else if (m === 'breakpointsChanged') {
                this.emu.worker.postMessage({ message: 'debugSnapshot' });
            }
        };
        emu.worker.addEventListener('message', this._workerListener);
    }

    focus() {
        this.emu.worker.postMessage({ message: 'debugSnapshot' });
    }
    blur() {
        this.emu.worker.removeEventListener('message', this._workerListener);
    }

    onKey(event) {
        const k = event.key;
        if (k === 'Escape' || k === 'F5') return 'close';
        if (k === 'F10') {
            this.cursorRow = 0;
            this.emu.worker.postMessage({ message: 'debugStep' });
            return 'consumed';
        }
        if (k === 'F11') {
            // Step-over: if the next instruction is CALL/RST, set a one-shot
            // BP and resume; the auto-open-on-bp wiring re-opens us. For
            // non-call instructions this behaves like a regular step.
            this.cursorRow = 0;
            this.emu.worker.postMessage({ message: 'debugStepOver' });
            // Resume emulator so the BP can fire. The handler back in
            // jsspeccy.js pauses on breakpointHit and re-pushes the widget.
            setTimeout(() => {
                if (this.emu.rzxMode !== 'playback') {
                    this.osd?.popWidget();
                    this.emu.start();
                }
            }, 30);
            return 'consumed';
        }
        if (k === 'F8') {
            this.emu.reset();
            setTimeout(() => this.emu.worker.postMessage({ message: 'debugSnapshot' }), 30);
            return 'consumed';
        }
        if (k === 'ArrowDown') {
            if (this.cursorRow < this.disasmAddrs.length - 1) this.cursorRow++;
            this.osd?.redraw();
            return 'consumed';
        }
        if (k === 'ArrowUp') {
            if (this.cursorRow > 0) this.cursorRow--;
            this.osd?.redraw();
            return 'consumed';
        }
        if (k === 'Home') { this.cursorRow = 0; this.osd?.redraw(); return 'consumed'; }
        if (k === 'F9' || k === 'b' || k === 'B') {
            const addr = this.disasmAddrs[this.cursorRow];
            if (addr !== undefined) {
                // Toggle: read current bp flag from snapshot if available, else assume off.
                const bpFlags = this.state ? new Uint8Array(this.state.bpFlags) : null;
                const memBase = this.state?.memBase ?? 0;
                const ofs = (addr - memBase) & 0xffff;
                const current = (bpFlags && ofs < bpFlags.length) ? bpFlags[ofs] : 0;
                this.emu.setBreakpoint(addr, !current);
            }
            return 'consumed';
        }
        if (k === 'c' || k === 'C') {
            this.emu.clearBreakpoints();
            return 'consumed';
        }
        if (k === 'p' || k === 'P') {
            const addr = this.disasmAddrs[this.cursorRow];
            if (addr !== undefined) {
                const s = prompt(`Poke at ${hex4(addr)} — byte value (hex):`, '00');
                if (s !== null) {
                    const v = parseInt(s, 16);
                    if (!isNaN(v)) this.emu.debugPoke(addr, v);
                }
            }
            return 'consumed';
        }
        return undefined;
    }

    draw(r) {
        r.drawDialog(0, 0, 320, 240, 'Z80 Debugger');

        const s = this.state;
        if (!s) {
            r.drawText(8, 20, 'fetching state...', COLOUR.BLACK, -1);
            return;
        }

        const regs = new Uint16Array(s.regs);
        const mem = new Uint8Array(s.mem);
        const memBase = s.memBase;
        const bpFlags = new Uint8Array(s.bpFlags);
        const memAt = (a) => {
            a = a & 0xffff;
            const ofs = (a - memBase) & 0xffff;
            return ofs < mem.length ? mem[ofs] : 0;
        };
        const bpAt = (a) => {
            a = a & 0xffff;
            const ofs = (a - memBase) & 0xffff;
            return ofs < bpFlags.length ? bpFlags[ofs] : 0;
        };

        const ink = COLOUR.BLACK;
        let row = 12;

        const af = regs[0];
        const fb = af & 0xff;
        const fStr =
            ((fb & 0x80) ? 'S' : '.') + ((fb & 0x40) ? 'Z' : '.') +
            ((fb & 0x20) ? '5' : '.') + ((fb & 0x10) ? 'H' : '.') +
            ((fb & 0x08) ? '3' : '.') + ((fb & 0x04) ? 'P' : '.') +
            ((fb & 0x02) ? 'N' : '.') + ((fb & 0x01) ? 'C' : '.');
        r.drawText(4,   row, `AF ${hex4(regs[0])}`, ink, -1);
        r.drawText(84,  row, `AF' ${hex4(regs[4])}`, ink, -1);
        r.drawText(172, row, `F ${fStr}`, ink, -1);
        row += 9;
        r.drawText(4,   row, `BC ${hex4(regs[1])}`, ink, -1);
        r.drawText(84,  row, `BC' ${hex4(regs[5])}`, ink, -1);
        r.drawText(172, row, `IM ${s.im} IFF ${s.iff1}${s.iff2}`, ink, -1);
        row += 9;
        r.drawText(4,   row, `DE ${hex4(regs[2])}`, ink, -1);
        r.drawText(84,  row, `DE' ${hex4(regs[6])}`, ink, -1);
        r.drawText(172, row, `IX ${hex4(regs[8])}`, ink, -1);
        row += 9;
        r.drawText(4,   row, `HL ${hex4(regs[3])}`, ink, -1);
        r.drawText(84,  row, `HL' ${hex4(regs[7])}`, ink, -1);
        r.drawText(172, row, `IY ${hex4(regs[9])}`, ink, -1);
        row += 9;
        r.drawText(4,   row, `PC ${hex4(s.pc)}`, ink, -1);
        r.drawText(84,  row, `SP ${hex4(regs[10])}`, ink, -1);
        r.drawText(172, row, `IR ${hex4(regs[11])}`, ink, -1);
        row += 9;
        r.drawText(4, row, `T ${s.tstates}${s.halted ? '  HALTED' : ''}`, ink, -1);
        row += 11;

        r.fillRect(4, row - 4, 312, 1, COLOUR.BLACK);

        // Disasm — 15 rows max so a footer fits.
        const lines = 15;
        this.disasmAddrs = [];
        let addr = s.pc;
        for (let i = 0; i < lines; i++) {
            this.disasmAddrs.push(addr);
            let text, length;
            try {
                const d = disasm(memAt, addr);
                text = d.text; length = d.length;
            } catch (e) { text = '??'; length = 1; }
            const bytes = [];
            for (let j = 0; j < length && j < 4; j++) bytes.push(hex2(memAt((addr + j) & 0xffff)));
            const isPC = (addr === s.pc);
            const isCursor = i === this.cursorRow;
            const hasBp = bpAt(addr);

            // Background priority: cursor > PC > none.
            if (isCursor) r.fillRect(4, row, 312, 9, COLOUR.BRIGHT_YELLOW);
            else if (isPC) r.fillRect(4, row, 312, 9, COLOUR.BRIGHT_CYAN);

            // Margin glyphs: ● for breakpoint, ► for PC.
            if (hasBp) r.drawText(4, row + 1, '*', COLOUR.RED, -1);
            if (isPC)  r.drawText(12, row + 1, '>', ink, -1);

            const body = `${hex4(addr)} ${bytes.join('').padEnd(8)} ${text}`;
            const truncated = body.length > 33 ? body.substring(0, 33) : body;
            r.drawText(22, row + 1, truncated, ink, -1);

            addr = (addr + length) & 0xffff;
            row += 9;
            if (row > 226) break;
        }

        r.fillRect(0, 230, 320, 10, COLOUR.BLACK);
        r.drawText(4, 231, 'F10:Step F11:Over F5:Cont b:BP p:Poke', COLOUR.WHITE, -1);
    }
}
