/*
 * Pokefinder — cheat-search workflow widget.
 *
 *   1. Press 'r' to take an initial snapshot of all 64K (all addresses are
 *      candidates).
 *   2. Play the game for a while (close this widget) until a value of
 *      interest changes (e.g. lose a life).
 *   3. Re-open the pokefinder and narrow the candidate set with:
 *        < — less than last snapshot
 *        > — greater than last snapshot
 *        = — equal to last snapshot (value unchanged)
 *        ! — not equal to last (value changed)
 *        v — equal to a specific byte (prompt)
 *   4. Repeat 2-3 until ≤ 16 candidates remain. The list shows
 *      addr + current value.
 *   5. Press 'p' to poke the highlighted candidate with a chosen byte
 *      (e.g. FF for max lives / ammo).
 */

import { COLOUR } from '../render.js';

const hex2 = (b) => (b & 0xff).toString(16).padStart(2,'0').toUpperCase();
const hex4 = (w) => (w & 0xffff).toString(16).padStart(4,'0').toUpperCase();
const LIST_ROWS = 20;

export class PokefinderWidget {
    constructor(emu) {
        this.emu = emu;
        this.osd = null;
        this.cursor = 0;
        this.samples = [];
        this.count = 0;

        this._stateHandler = (data) => {
            this.count = data.count;
            this._fetchSamples();
        };
        emu.on('pokefinderState', this._stateHandler);
    }

    focus() { this._fetchSamples(); }
    blur()  { this.emu.off?.('pokefinderState', this._stateHandler); }

    _fetchSamples() {
        this.emu.pokefinderSamples(LIST_ROWS).then((data) => {
            this.samples = data.samples;
            this.count = data.count;
            if (this.cursor >= this.samples.length) this.cursor = Math.max(0, this.samples.length - 1);
            this.osd?.redraw();
        });
    }

    onKey(event) {
        const k = event.key;
        if (k === 'Escape') return 'close';
        if (k === 'r' || k === 'R') {
            this.emu.pokefinderReset();
            return 'consumed';
        }
        if (k === '<') { this.emu.pokefinderNarrow('less');     return 'consumed'; }
        if (k === '>') { this.emu.pokefinderNarrow('greater');  return 'consumed'; }
        if (k === '=') { this.emu.pokefinderNarrow('equal');    return 'consumed'; }
        if (k === '!') { this.emu.pokefinderNarrow('notEqual'); return 'consumed'; }
        if (k === 'v' || k === 'V') {
            const s = prompt('Search byte value (hex):', '00');
            if (s !== null) {
                const v = parseInt(s, 16);
                if (!isNaN(v)) this.emu.pokefinderNarrow('value', v);
            }
            return 'consumed';
        }
        if (k === 'ArrowDown') {
            if (this.cursor < this.samples.length - 1) this.cursor++;
            this.osd?.redraw();
            return 'consumed';
        }
        if (k === 'ArrowUp') {
            if (this.cursor > 0) this.cursor--;
            this.osd?.redraw();
            return 'consumed';
        }
        if (k === 'p' || k === 'P') {
            const sel = this.samples[this.cursor];
            if (sel) {
                const s = prompt(`Poke ${hex4(sel.addr)} with byte (hex):`, 'FF');
                if (s !== null) {
                    const v = parseInt(s, 16);
                    if (!isNaN(v)) {
                        this.emu.debugPoke(sel.addr, v);
                        setTimeout(() => this._fetchSamples(), 20);
                    }
                }
            }
            return 'consumed';
        }
        return undefined;
    }

    draw(r) {
        r.drawDialog(0, 0, 320, 240, 'Pokefinder');

        const ink = COLOUR.BLACK;
        r.drawText(4, 12, `Candidates: ${this.count} / 65536`, ink, -1);

        if (this.count === 0 || !this.samples) {
            r.drawText(4, 30, "Press 'r' to start. , come back,", ink, -1);
            r.drawText(4, 39, "and narrow with < > = ! v.", ink, -1);
        } else {
            r.drawText(4, 24, `Showing first ${this.samples.length}:`, ink, -1);
            let row = 36;
            for (let i = 0; i < this.samples.length; i++) {
                const s = this.samples[i];
                if (i === this.cursor) r.fillRect(4, row, 312, 9, COLOUR.BRIGHT_YELLOW);
                r.drawText(8, row + 1,
                    `${hex4(s.addr)}  ${hex2(s.value)}  (${s.value})`,
                    ink, -1);
                row += 9;
                if (row > 215) break;
            }
        }

        r.fillRect(0, 230, 320, 10, COLOUR.BLACK);
        r.drawText(4, 231, 'r:Reset < > = ! v  p:Poke  Esc', COLOUR.WHITE, -1);
    }
}
