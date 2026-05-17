/*
 * TapeBrowserWidget — shows loaded tape blocks, lets user seek to any block.
 *
 * Keys: ArrowUp/Down scroll, Enter seeks to selected block, Escape/F1 close.
 * The current tape position is marked with '>'.
 */

import { COLOUR } from '../render.js';

const ROW_H    = 9;
const TITLE_H  = 11;
const PAD_X    = 4;
const PAD_Y    = 2;
const VISIBLE  = 16;  // max visible rows

export class TapeBrowserWidget {
    /**
     * @param {object[]} blocks  — from emu.getTapeBlocks()
     * @param {function} onSeek  — called with index when user selects a block
     */
    constructor(blocks, onSeek) {
        this.blocks  = blocks;
        this.onSeek  = onSeek;
        this.cursor  = Math.max(0, blocks.findIndex(b => b.current));
        this.scroll  = Math.max(0, this.cursor - Math.floor(VISIBLE / 2));
        this.osd     = null;
    }

    focus() {}
    blur()  {}

    onKey(event) {
        const k = event.key;
        if (k === 'Escape' || k === 'F1') return 'close';
        if (k === 'ArrowUp' || k === '7') {
            if (this.cursor > 0) {
                this.cursor--;
                if (this.cursor < this.scroll) this.scroll = this.cursor;
            }
            return 'consumed';
        }
        if (k === 'ArrowDown' || k === '8') {
            if (this.cursor < this.blocks.length - 1) {
                this.cursor++;
                if (this.cursor >= this.scroll + VISIBLE) this.scroll = this.cursor - VISIBLE + 1;
            }
            return 'consumed';
        }
        if (k === 'Enter' || k === ' ') {
            if (this.blocks.length > 0) {
                this.onSeek(this.cursor);
                return 'close';
            }
        }
        return undefined;
    }

    draw(r) {
        const visible = Math.min(VISIBLE, this.blocks.length || 1);
        const w = Math.min(280, 312);
        const h = TITLE_H + PAD_Y + visible * ROW_H + PAD_Y;
        const x = Math.floor((320 - w) / 2);
        const y = Math.floor((240 - h) / 2);

        r.drawDialog(x, y, w, h, 'Tape Browser');

        if (this.blocks.length === 0) {
            r.drawText(x + PAD_X + 1, y + TITLE_H + PAD_Y, 'No tape loaded', COLOUR.BLACK, -1);
            return;
        }

        let curY = y + TITLE_H + PAD_Y;
        const end = Math.min(this.scroll + VISIBLE, this.blocks.length);
        for (let i = this.scroll; i < end; i++) {
            const b = this.blocks[i];
            const selected = i === this.cursor;
            const paper = selected ? COLOUR.BRIGHT_CYAN : COLOUR.WHITE;
            r.fillRect(x + 1, curY, w - 2, ROW_H, paper);

            const marker = b.current ? '>' : ' ';
            // Truncate detail so it fits in the dialog width
            const maxChars = Math.floor((w - PAD_X * 2 - 16) / 8);
            const label = `${marker}${String(i).padStart(3, ' ')} ${b.detail || b.kind}`.slice(0, maxChars);
            r.drawText(x + PAD_X + 1, curY + 1, label, COLOUR.BLACK, -1);
            curY += ROW_H;
        }
    }
}
