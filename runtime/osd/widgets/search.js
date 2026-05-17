/*
 * SearchWidget — ZXInfo search dialog.
 *
 * Shows a text-input bar + scrollable results list.
 * Uses a transparent HTML <input> element positioned over the OSD canvas
 * so mobile devices show their native keyboard.
 *
 * Keys (desktop):
 *   Printable chars / Backspace  — edit query
 *   Enter                        — load first/selected result
 *   ArrowUp / ArrowDown          — navigate results
 *   Escape / F1                  — close
 *
 * ZXInfo API: https://api.zxinfo.dk/v3/
 */

import { COLOUR } from '../render.js';

// Internet Archive Spectrum collection — same backend the legacy jsspeccy
// "Find games..." DOM dialog used. Kept named API_BASE for compatibility
// with the rest of the widget.
const API_BASE = 'https://archive.org';
const RESULT_MAX = 20;
const DEBOUNCE   = 400; // ms

const ROW_H    = 9;
const TITLE_H  = 11;
const INPUT_H  = 11;
const PAD_X    = 4;
const PAD_Y    = 2;
const VISIBLE  = 14;

export class SearchWidget {
    /**
     * @param {HTMLElement} inputEl  — transparent <input> managed by Osd
     * @param {function}    onLoad   — called with URL string to load
     */
    constructor(inputEl, onLoad) {
        this.inputEl = inputEl;
        this.onLoad  = onLoad;
        this.osd     = null;

        this.query   = '';
        this.results = [];   // [{title, publisher, year, files:[{url,format}]}]
        this.cursor  = 0;
        this.scroll  = 0;
        this.status  = '';   // 'searching' | 'error' | ''
        this._debounceTimer = null;
    }

    focus() {
        if (this.inputEl) {
            this.inputEl.value = this.query;
            this.inputEl.style.display = 'block';
            // Slight defer so the OSD animation frame doesn't steal focus
            setTimeout(() => this.inputEl.focus(), 50);
            this.inputEl.oninput = () => {
                this.query = this.inputEl.value;
                this._scheduleSearch();
                this.osd?.redraw();
            };
        }
    }

    blur() {
        if (this.inputEl) {
            this.inputEl.style.display = 'none';
            this.inputEl.oninput = null;
        }
    }

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
            if (this.cursor < this.results.length - 1) {
                this.cursor++;
                if (this.cursor >= this.scroll + VISIBLE) this.scroll = this.cursor - VISIBLE + 1;
            }
            return 'consumed';
        }
        if (k === 'Enter') {
            this._activateSelected();
            return 'consumed';
        }

        // Text input — OSD intercepts all keys before <input> gets them,
        // so we handle typing here on both desktop and mobile.
        // On mobile the inputEl.oninput path also fires (native keyboard),
        // but that syncs query→inputEl, so no double-input occurs.
        if (k === 'Backspace') {
            this.query = this.query.slice(0, -1);
            if (this.inputEl) this.inputEl.value = this.query;
            this._scheduleSearch();
            return 'consumed';
        }
        if (k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            this.query += k;
            if (this.inputEl) this.inputEl.value = this.query;
            this._scheduleSearch();
            return 'consumed';
        }

        return undefined;
    }

    onTouch(canvasX, canvasY) {
        // Find which result row was tapped
        const { x, y, w } = this._layout();
        const listTop = y + TITLE_H + PAD_Y + INPUT_H + PAD_Y;
        if (canvasY < listTop) return undefined;
        const row = Math.floor((canvasY - listTop) / ROW_H);
        const idx = this.scroll + row;
        if (idx >= 0 && idx < this.results.length) {
            this.cursor = idx;
            this._activateSelected();
            return 'consumed';
        }
        return undefined;
    }

    draw(r) {
        const { x, y, w, h } = this._layout();
        r.drawDialog(x, y, w, h, 'Search ZXInfo');

        // Input bar
        const inputY = y + TITLE_H + PAD_Y;
        r.fillRect(x + 1, inputY, w - 2, INPUT_H, COLOUR.BRIGHT_WHITE);
        r.fillRect(x + 1, inputY, w - 2, INPUT_H, COLOUR.WHITE);
        const displayQuery = this.query + (Date.now() % 1000 < 500 ? '_' : ' ');
        r.drawText(x + PAD_X, inputY + 1, displayQuery.slice(-(Math.floor((w - PAD_X * 2) / 8))), COLOUR.BLACK, -1);

        // Position mobile input element over the input bar
        this._positionInputEl(x, inputY, w, INPUT_H);

        // Status / results
        const listTop = inputY + INPUT_H + PAD_Y;

        if (this.status === 'searching') {
            r.drawText(x + PAD_X, listTop + 1, 'Searching...', COLOUR.BLACK, -1);
            return;
        }
        if (this.status === 'loading') {
            r.drawText(x + PAD_X, listTop + 1, 'Loading...', COLOUR.BLACK, -1);
            return;
        }
        if (this.status === 'nofiles') {
            r.drawText(x + PAD_X, listTop + 1, 'No files available', COLOUR.BRIGHT_RED, -1);
            return;
        }
        if (this.status === 'error') {
            r.drawText(x + PAD_X, listTop + 1, 'Error - check connection', COLOUR.BRIGHT_RED, -1);
            return;
        }
        if (this.results.length === 0 && this.query.length > 0) {
            r.drawText(x + PAD_X, listTop + 1, 'No results', COLOUR.BLACK, -1);
            return;
        }
        if (this.results.length === 0) {
            r.drawText(x + PAD_X, listTop + 1, 'Type to search...', COLOUR.BLACK, -1);
            return;
        }

        const end = Math.min(this.scroll + VISIBLE, this.results.length);
        let curY = listTop;
        for (let i = this.scroll; i < end; i++) {
            const res = this.results[i];
            const sel = i === this.cursor;
            r.fillRect(x + 1, curY, w - 2, ROW_H, sel ? COLOUR.BRIGHT_CYAN : COLOUR.WHITE);
            const maxChars = Math.floor((w - PAD_X * 2) / 8);
            const label = `${res.title}${res.year ? ' (' + res.year + ')' : ''}`.slice(0, maxChars);
            r.drawText(x + PAD_X, curY + 1, label, COLOUR.BLACK, -1);
            curY += ROW_H;
        }
    }

    // ── private ──────────────────────────────────────────────────────────────

    _layout() {
        const w = Math.min(296, 312);
        const h = Math.min(TITLE_H + PAD_Y + INPUT_H + PAD_Y + VISIBLE * ROW_H + PAD_Y, 232);
        const x = Math.floor((320 - w) / 2);
        const y = Math.floor((240 - h) / 2);
        return { x, y, w, h };
    }

    _positionInputEl(osdX, osdY, osdW, osdH) {
        if (!this.inputEl || !this.osd) return;
        const canvas = this.osd.canvas;
        const rect   = canvas.getBoundingClientRect();
        if (rect.width === 0) return;
        const scaleX = rect.width  / 320;
        const scaleY = rect.height / 240;
        const left   = rect.left + window.scrollX + osdX * scaleX;
        const top    = rect.top  + window.scrollY + osdY * scaleY;
        this.inputEl.style.left   = `${left}px`;
        this.inputEl.style.top    = `${top}px`;
        this.inputEl.style.width  = `${osdW * scaleX}px`;
        this.inputEl.style.height = `${osdH * scaleY}px`;
    }

    _scheduleSearch() {
        clearTimeout(this._debounceTimer);
        this.results = [];
        this.cursor  = 0;
        this.scroll  = 0;
        if (this.query.trim().length < 2) { this.status = ''; return; }
        this.status = 'searching';
        this._debounceTimer = setTimeout(() => this._doSearch(), DEBOUNCE);
    }

    async _doSearch() {
        const q = this.query.trim();
        if (q.length < 2) return;
        try {
            const safeQ = q.replace(/[^\w\s\-']/g, '');
            const params = [
                ['q', `collection:softwarelibrary_zx_spectrum title:"${safeQ}"`],
                ['fl[]', 'creator'],
                ['fl[]', 'identifier'],
                ['fl[]', 'title'],
                ['rows', String(RESULT_MAX)],
                ['page', '1'],
                ['output', 'json'],
            ].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
            const url = `${API_BASE}/advancedsearch.php?${params}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.results = this._parseResults(data);
            console.log('[Search] results:', this.results.length, this.results.map(r => r.title));
            this.status  = '';
        } catch (err) {
            console.warn('Archive.org search failed:', err);
            this.status  = 'error';
            this.results = [];
        }
        this.osd?.redraw();
    }

    _parseResults(data) {
        const docs = data?.response?.docs ?? [];
        return docs.map((d) => ({
            id: d.identifier,
            title: d.title ?? d.identifier,
            publisher: Array.isArray(d.creator) ? d.creator.join(', ') : (d.creator ?? ''),
            year: '',
        }));
    }

    async _activateSelected() {
        const res = this.results[this.cursor];
        if (!res) { console.log('[Search] _activateSelected: no result at cursor', this.cursor); return; }

        console.log('[Search] activating:', res.title, 'id=', res.id);

        // Fetch full game record to get reliable file list
        this.status = 'loading';
        this.osd?.redraw();

        let files = [];
        try {
            const apiUrl = `${API_BASE}/metadata/${encodeURIComponent(res.id)}`;
            console.log('[Search] fetching item metadata:', apiUrl);
            const resp = await fetch(apiUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            files = this._extractFiles(data, res.id);
            console.log('[Search] extracted files:', files);
        } catch (err) {
            console.warn('[Search] item fetch failed:', err);
            this.status = 'error';
            this.osd?.redraw();
            return;
        }

        if (files.length === 0) {
            console.warn('[Search] no downloadable files for', res.title);
            this.status = 'nofiles';
            this.osd?.redraw();
            return;
        }

        // Already sorted by preference (TZX > TAP > Z80 > SNA > SZX) in _extractFiles
        const best = files[0];
        const fileUrl = this._resolveUrl(best.url);
        console.log('[Search] loading:', fileUrl);

        this.osd?.close();
        try {
            await this.onLoad(fileUrl);
        } catch (err) {
            console.error('[Search] onLoad failed:', fileUrl, err);
        }
    }

    _extractFiles(metadata, identifier) {
        // archive.org metadata response shape: { files: [{ name, format, ... }, ...] }.
        // We pick the first file whose extension is a supported Spectrum
        // format, preferring TZX > TAP > Z80 > SNA > SZX (loader-friendly).
        const FORMAT_RANK = { tzx: 0, tap: 1, z80: 2, sna: 3, szx: 4 };
        const files = [];
        for (const f of (metadata.files ?? [])) {
            const name = f.name ?? '';
            const ext = name.split('.').pop()?.toLowerCase();
            if (!FORMAT_RANK.hasOwnProperty(ext)) continue;
            // archive.org's /download/ endpoint 302-redirects to an
            // ia*.us.archive.org host that does NOT serve CORS headers, so
            // we route through the cors.archive.org proxy (legacy jsspeccy
            // approach). Path-segment-encode the filename to preserve any
            // subdir separators while escaping spaces / brackets.
            const safeName = name.split('/').map(encodeURIComponent).join('/');
            files.push({
                url: `https://cors.archive.org/cors/${encodeURIComponent(identifier)}/${safeName}`,
                format: ext,
                rank: FORMAT_RANK[ext],
            });
        }
        files.sort((a, b) => a.rank - b.rank);
        return files;
    }

    _resolveUrl(url) {
        return url;  // archive.org files are already absolute URLs.
    }
}
