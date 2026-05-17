/*
 * Memory viewer / editor widget. Hex + ASCII dump of a sliding 64-byte
 * window into wasm address space.
 *
 * Layout (320 × 240 OSD canvas, 8-px font):
 *   Title bar
 *   16 rows × 8 bytes per row = 128 bytes visible, ~24 cols + ASCII
 *   Footer: hotkey hints
 *
 * Cursor selects a single byte; edits poke that address. PageUp/PageDown
 * jump by a screen, arrow keys move byte-by-byte, 'g' prompts for a goto
 * address, 'e' (or Enter) edits the byte under cursor.
 */

import { COLOUR } from '../render.js';

const ROWS = 16;
const COLS = 8;
const WINDOW_SIZE = ROWS * COLS;

const hex2 = (b) => (b & 0xff).toString(16).padStart(2,'0').toUpperCase();
const hex4 = (w) => (w & 0xffff).toString(16).padStart(4,'0').toUpperCase();

export class MemoryWidget {
    constructor(emu, opts = {}) {
        this.emu = emu;
        this.osd = null;
        this.base = (opts.base ?? 0x4000) & 0xfff8;    // align to 8
        this.cursor = opts.cursor ?? this.base;
        this.bytes = null;        // last fetched window

        this._workerListener = (e) => {
            if (e.data?.message === 'debugMemData' && this._pendingFetch === e.data.queryId) {
                this.bytes = new Uint8Array(e.data.bytes);
                this.osd?.redraw();
            }
        };
    }

    focus() {
        this._fetch();
    }
    blur() {}

    onKey(event) {
        const k = event.key;
        if (k === 'Escape') return 'close';
        if (k === 'ArrowDown') { this._moveCursor(+COLS); return 'consumed'; }
        if (k === 'ArrowUp')   { this._moveCursor(-COLS); return 'consumed'; }
        if (k === 'ArrowRight'){ this._moveCursor(+1);    return 'consumed'; }
        if (k === 'ArrowLeft') { this._moveCursor(-1);    return 'consumed'; }
        if (k === 'PageDown')  { this._moveCursor(+WINDOW_SIZE); return 'consumed'; }
        if (k === 'PageUp')    { this._moveCursor(-WINDOW_SIZE); return 'consumed'; }
        if (k === 'Home') { this.cursor = this.base; this.osd?.redraw(); return 'consumed'; }
        if (k === 'End')  { this.cursor = (this.base + WINDOW_SIZE - 1) & 0xffff; this.osd?.redraw(); return 'consumed'; }
        if (k === 'g' || k === 'G') {
            const s = prompt('Goto address (hex):', hex4(this.cursor));
            if (s !== null) {
                const v = parseInt(s, 16);
                if (!isNaN(v)) {
                    this.base = v & 0xfff8;
                    this.cursor = v & 0xffff;
                    this._fetch();
                }
            }
            return 'consumed';
        }
        if (k === 'e' || k === 'E' || k === 'Enter' || k === ' ') {
            const s = prompt(`Set byte at ${hex4(this.cursor)} (hex):`,
                             this.bytes ? hex2(this.bytes[(this.cursor - this.base) & 0xffff]) : '00');
            if (s !== null) {
                const v = parseInt(s, 16);
                if (!isNaN(v)) {
                    this.emu.debugPoke(this.cursor, v);
                    setTimeout(() => this._fetch(), 20);
                }
            }
            return 'consumed';
        }
        return undefined;
    }

    _moveCursor(delta) {
        this.cursor = (this.cursor + delta) & 0xffff;
        // Auto-scroll: if cursor leaves window, recenter base.
        if (this.cursor < this.base || this.cursor >= this.base + WINDOW_SIZE) {
            this.base = (this.cursor - (WINDOW_SIZE >> 1)) & 0xfff8;
            this._fetch();
        } else {
            this.osd?.redraw();
        }
    }

    _fetch() {
        if (!this.osd) { setTimeout(() => this._fetch(), 30); return; }
        this._pendingFetch = (Math.random() * 1e9) | 0;
        const promise = this.emu.debugReadMem(this.base, WINDOW_SIZE);
        promise.then((data) => {
            this.bytes = new Uint8Array(data.bytes);
            this.osd?.redraw();
        });
    }

    draw(r) {
        r.drawDialog(0, 0, 320, 240, `Memory @ ${hex4(this.base)}`);
        if (!this.bytes) {
            r.drawText(8, 20, 'loading...', COLOUR.BLACK, -1);
            return;
        }
        const ink = COLOUR.BLACK;
        let row = 12;
        for (let line = 0; line < ROWS; line++) {
            const addr = (this.base + line * COLS) & 0xffff;
            r.drawText(4, row + 1, hex4(addr), ink, -1);
            for (let col = 0; col < COLS; col++) {
                const ofs = line * COLS + col;
                const b = this.bytes[ofs];
                const x = 44 + col * 18;
                const here = (this.base + ofs) & 0xffff;
                if (here === this.cursor) {
                    r.fillRect(x - 1, row, 17, 9, COLOUR.BRIGHT_YELLOW);
                }
                r.drawText(x, row + 1, hex2(b), ink, -1);
            }
            // ASCII column
            const ax = 44 + COLS * 18 + 6;
            for (let col = 0; col < COLS; col++) {
                const b = this.bytes[line * COLS + col];
                const ch = (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
                r.drawText(ax + col * 8, row + 1, ch, ink, -1);
            }
            row += 9;
        }
        // Footer
        r.fillRect(0, 230, 320, 10, COLOUR.BLACK);
        r.drawText(4, 231, 'arrows/PgUp/PgDn  g:Goto  e:Edit  Esc', COLOUR.WHITE, -1);
    }
}
