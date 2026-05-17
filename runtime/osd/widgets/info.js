/*
 * InfoWidget — shows a read-only text dialog in the OSD.
 *
 * lines: array of strings. An empty string renders as a blank separator row.
 * Close with Enter, Space, Escape or F1.
 */

import { COLOUR } from '../render.js';

export class InfoWidget {
    /**
     * @param {string} title
     * @param {string[]} lines
     */
    constructor(title, lines) {
        this.title = title;
        this.lines = lines;
        this.osd = null;
    }

    focus() {}
    blur()  {}

    onKey(event) {
        const k = event.key;
        if (k === 'Escape' || k === 'F1' || k === 'Enter' || k === ' ') {
            return 'close';
        }
        return undefined;
    }

    draw(r) {
        const lineH  = 9;
        const padX   = 6;
        const padY   = 3;
        const titleH = 11;

        const maxLineLen = this.lines.reduce((m, l) => Math.max(m, l.length), this.title.length + 4);
        const w = Math.min(maxLineLen * 8 + padX * 2, 312);
        const h = Math.min(titleH + padY + this.lines.length * lineH + padY, 232);
        const x = Math.floor((320 - w) / 2);
        const y = Math.floor((240 - h) / 2);

        r.drawDialog(x, y, w, h, this.title);

        let curY = y + titleH + padY;
        for (const line of this.lines) {
            if (line !== '') {
                r.drawText(x + padX, curY, line, COLOUR.BLACK, -1);
            }
            curY += lineH;
        }
    }
}
