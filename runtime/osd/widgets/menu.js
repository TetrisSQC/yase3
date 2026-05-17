/*
 * MenuWidget — selectable menu rendered into the OSD canvas.
 *
 * A MenuEntry is one of:
 *   { label, action(ctx) }                            — leaf
 *   { label, submenu: () => MenuEntry[] }             — nested menu (lazy)
 *   { label, inactive: true }                         — disabled
 *   { label, detail: () => string, action(ctx) }      — right-aligned status
 *   { label, separator: true }                        — visual divider
 *
 * Keys:
 *   ArrowUp / 7        — move selection up
 *   ArrowDown / 8      — move selection down
 *   Enter / Space      — activate selection
 *   Escape / F1        — close this menu
 *   Home / End         — jump to first/last entry
 */

import { COLOUR } from '../render.js';

export class MenuWidget {
    /**
     * @param {string} title
     * @param {Array} entries
     * @param {{ context: any, onClose?: () => void }} [opts]
     */
    constructor(title, entries, opts = {}) {
        this.title = title;
        this.entries = entries;
        this.context = opts.context;
        this.onClose = opts.onClose;

        this.osd = null;
        this.cursor = this._firstSelectable(0, +1);
    }

    _isSelectable(i) {
        const e = this.entries[i];
        return e && !e.separator && !e.inactive;
    }

    _firstSelectable(from, step) {
        const n = this.entries.length;
        for (let k = 0; k < n; k++) {
            const i = (from + step * k + n) % n;
            if (this._isSelectable(i)) return i;
        }
        return 0;
    }

    focus()  {}
    blur()   {}

    onKey(event) {
        const k = event.key;
        if (k === 'Escape' || k === 'F1') {
            this.onClose?.();
            return 'close';
        }
        if (k === 'ArrowUp' || k === '7') {
            this.cursor = this._firstSelectable(this.cursor - 1, -1);
            return 'consumed';
        }
        if (k === 'ArrowDown' || k === '8') {
            this.cursor = this._firstSelectable(this.cursor + 1, +1);
            return 'consumed';
        }
        if (k === 'Home') {
            this.cursor = this._firstSelectable(0, +1);
            return 'consumed';
        }
        if (k === 'End') {
            this.cursor = this._firstSelectable(this.entries.length - 1, -1);
            return 'consumed';
        }
        if (k === 'Enter' || k === ' ') {
            this._activate();
            return 'consumed';
        }
        // Letter shortcut: jump to + activate the matching A: / B: / ... entry.
        if (k && k.length === 1) {
            const upper = k.toUpperCase();
            if (upper >= 'A' && upper <= 'Z') {
                const target = upper.charCodeAt(0) - 0x41;
                let letter = 0;
                for (let i = 0; i < this.entries.length; i++) {
                    const e = this.entries[i];
                    if (e.separator) continue;
                    if (letter === target) {
                        if (!e.inactive) {
                            this.cursor = i;
                            this._activate();
                            return 'consumed';
                        }
                        return 'consumed';
                    }
                    letter++;
                }
            }
        }
        return undefined;
    }

    async _activate() {
        const entry = this.entries[this.cursor];
        if (!entry || entry.inactive || entry.separator) return;
        if (entry.submenu) {
            const submenuEntries = await entry.submenu(this.context);
            this.osd.pushWidget(new MenuWidget(entry.label, submenuEntries, {
                context: this.context,
            }));
            return;
        }
        if (entry.action) {
            const result = await entry.action(this.context);
            // Convention: action returning 'close' dismisses this menu.
            if (result === 'close') {
                this.onClose?.();
                this.osd.popWidget();
            } else {
                this.osd.redraw();
            }
        }
    }

    /**
     * Hotkey letter used as the visible prefix and as a quick-jump shortcut.
     * "A:" / "B:" / ... numbering, skipping separators and
     * inactive items.
     */
    _hotkeyForIndex(i) {
        let letter = 0;
        for (let k = 0; k <= i; k++) {
            const e = this.entries[k];
            if (e.separator) continue;
            if (k === i) return String.fromCharCode(0x41 + letter);
            letter++;
        }
        return null;
    }

    onTouch(canvasX, canvasY) {
        const entries  = this.entries;
        const rowHeight = 9;
        const titleHeight = 11;
        const padX = 4;

        let maxLabelLen = this.title.length + 3;
        for (const e of entries) {
            if (!e.separator) maxLabelLen = Math.max(maxLabelLen, e.label.length + 3);
        }
        const w = Math.min(maxLabelLen * 8 + padX * 2, 320 - 8);
        const h = Math.min(entries.length * rowHeight + titleHeight + 4, 240 - 8);
        const x = Math.floor((320 - w) / 2);
        const y = Math.floor((240 - h) / 2);

        const listTop = y + titleHeight + 2;
        if (canvasY < listTop) return undefined;
        const row = Math.floor((canvasY - listTop) / rowHeight);
        if (row < 0 || row >= entries.length) return undefined;

        const entry = entries[row];
        if (!entry || entry.separator || entry.inactive) return undefined;

        this.cursor = row;
        this._activate();
        return 'consumed';
    }

    draw(r) {
        const entries = this.entries;
        const rowHeight = 9;
        const titleHeight = 11;
        const padX = 4;

        // Width budget. Each label is prefixed with "A: " (3 chars) so factor
        // that in. Title also needs room for the rainbow flag (16 px ≈ 2 chars).
        const titleSlackChars = 3;
        const PREFIX_CHARS = 3;
        let maxLabelLen = this.title.length + titleSlackChars;
        let maxDetailLen = 0;
        for (const e of entries) {
            if (e.separator) continue;
            const len = e.label.length + PREFIX_CHARS + (e.submenu ? 2 : 0);
            maxLabelLen = Math.max(maxLabelLen, len);
            const d = e.detail?.(this.context);
            if (d) maxDetailLen = Math.max(maxDetailLen, d.length);
        }
        const innerWidth = (maxLabelLen + (maxDetailLen ? maxDetailLen + 2 : 0)) * 8 + padX * 2;
        const innerHeight = entries.length * rowHeight + titleHeight + 4;

        const w = Math.min(innerWidth, 320 - 8);
        const h = Math.min(innerHeight, 240 - 8);
        const x = Math.floor((320 - w) / 2);
        const y = Math.floor((240 - h) / 2);

        r.drawDialog(x, y, w, h, this.title);

        let cursorY = y + titleHeight + 2;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.separator) {
                r.fillRect(x + padX, cursorY + 3, w - padX * 2, 1, COLOUR.BLACK);
                cursorY += rowHeight;
                continue;
            }
            const selected = i === this.cursor;
            // Body rows: white paper, black text. Selected row: cyan paper.
            // Inactive items keep the same colours but rendered dimmer would
            // need a separate palette — for now they share the body style.
            const paper = selected ? COLOUR.BRIGHT_CYAN : COLOUR.BRIGHT_WHITE;
            const ink = COLOUR.BLACK;
            // Full-width row fill including padding.
            r.fillRect(x + 1, cursorY, w - 2, rowHeight, paper);

            const hotkey = this._hotkeyForIndex(i);
            const labelWithPrefix = hotkey ? `${hotkey}: ${entry.label}` : entry.label;
            r.drawText(x + padX + 1, cursorY + 1, labelWithPrefix, ink, -1);

            const detail = entry.detail?.(this.context);
            if (detail) {
                r.drawTextRight(x + w - padX - 1, cursorY + 1, detail, ink, -1);
            } else if (entry.submenu) {
                r.drawTextRight(x + w - padX - 1, cursorY + 1, '>', ink, -1);
            }
            cursorY += rowHeight;
        }
    }
}
