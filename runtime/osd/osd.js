/*
 * OSD lifecycle controller.
 *
 * Owns a transparent 2D canvas stacked over the emulator framebuffer canvas.
 * Pushes/pops Widget instances on an internal stack (depth 10). When the
 * stack is non-empty the OSD is "open" — emulation is paused, keyboard is
 * captured, top widget receives input and draws.
 *
 * Widgets implement:
 *   draw(renderer)
 *   onKey(event) → 'consumed' | 'close' | undefined
 *   focus() / blur()
 *
 * close() options:
 *   - widget calls osd.popWidget() to dismiss itself
 *   - osd.close() empties stack and resumes emulation
 */

import { OsdRenderer } from './render.js';

const MAX_STACK = 10;

export class Osd {
    /**
     * @param {HTMLElement} container  Element that holds the main canvas.
     * @param {HTMLCanvasElement} mainCanvas  Emulator framebuffer canvas.
     * @param {Object} hooks  { pause(), resume(), isRunning() }
     */
    constructor(container, mainCanvas, hooks) {
        this.mainCanvas = mainCanvas;
        this.hooks = hooks;

        this.canvas = document.createElement('canvas');
        this.canvas.width = 320;
        this.canvas.height = 240;
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.display = 'none';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.imageRendering = 'pixelated';
        this.canvas.style.zIndex = '50';
        container.appendChild(this.canvas);

        // Transparent <input> for mobile keyboard — used by SearchWidget.
        // Sits above the OSD canvas (zIndex 60) but is hidden by default.
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.autocomplete = 'off';
        this.searchInput.autocorrect = 'off';
        this.searchInput.autocapitalize = 'off';
        this.searchInput.spellcheck = false;
        this.searchInput.style.position = 'fixed';
        this.searchInput.style.opacity = '0';
        this.searchInput.style.pointerEvents = 'none';
        this.searchInput.style.zIndex = '60';
        this.searchInput.style.fontSize = '16px'; // prevent iOS zoom on focus
        this.searchInput.style.display = 'none';
        document.body.appendChild(this.searchInput);

        this.renderer = new OsdRenderer(this.canvas);

        this.stack = [];
        this._wasRunning = false;
        this._syncSize();

        // Match main-canvas sizing/position whenever they change (zoom,
        // fullscreen, menubar visibility toggling).
        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this._syncSize());
            this._ro.observe(mainCanvas);
            // Also observe the container so we catch menubar height changes
            // that shift the main canvas down without resizing it.
            this._ro.observe(container);
        }
        window.addEventListener('resize', () => this._syncSize());
    }

    _syncSize() {
        const main = this.mainCanvas;
        const rect = main.getBoundingClientRect();
        if (rect.width === 0) return;
        // Position absolute, parent is the appContainer (position:relative).
        // Use offsetTop/offsetLeft to land directly on the main canvas — the
        // appContainer's top-left can sit above the canvas when the menubar
        // pushes the canvas down.
        // Use pixel dims from the bounding rect rather than main.style.width.
        // When main has style.width='100%' the absolutely-positioned OSD canvas
        // would resolve 100% against the padding box of its containing block,
        // overlapping any padding-bottom reserved for the on-screen ZX keyboard.
        this.canvas.style.top = `${main.offsetTop}px`;
        this.canvas.style.left = `${main.offsetLeft}px`;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
    }

    get isOpen() {
        return this.stack.length > 0;
    }

    pushWidget(widget) {
        if (this.stack.length >= MAX_STACK) {
            throw new Error(`Osd: widget stack overflow (max ${MAX_STACK})`);
        }
        const wasEmpty = this.stack.length === 0;
        if (this.stack.length > 0) {
            this.stack[this.stack.length - 1].blur?.();
        }
        this.stack.push(widget);
        widget.osd = this;
        widget.focus?.();

        if (wasEmpty) {
            this._wasRunning = this.hooks.isRunning?.() ?? false;
            this.hooks.pause?.();
            this._syncSize();
            this.canvas.style.display = 'block';
            this.canvas.style.pointerEvents = 'auto';
            this.mainCanvas.style.filter = 'blur(4px)';
            this._attachTouchListeners();
        }
        this.redraw();
    }

    popWidget() {
        if (this.stack.length === 0) return;
        const w = this.stack.pop();
        w.blur?.();
        w.osd = null;
        if (this.stack.length === 0) {
            this.canvas.style.display = 'none';
            this.canvas.style.pointerEvents = 'none';
            this.mainCanvas.style.filter = '';
            this._detachTouchListeners();
            if (this._wasRunning) this.hooks.resume?.();
        } else {
            this.stack[this.stack.length - 1].focus?.();
            this.redraw();
        }
    }

    close() {
        while (this.stack.length > 0) this.popWidget();
    }

    redraw() {
        const r = this.renderer;
        r.clear();
        // Draw each widget in stack order; top widget overdraws lower ones
        // (nested dialogs leave the stack visible underneath).
        for (const w of this.stack) w.draw(r);
    }

    /**
     * Forward a keyboard event from the host to the top widget. Returns true
     * if the event was consumed (caller should preventDefault).
     */
    onKeyDown(event) {
        if (this.stack.length === 0) return false;
        const w = this.stack[this.stack.length - 1];
        const result = w.onKey?.(event);
        if (result === 'close') {
            this.popWidget();
            return true;
        }
        if (result === 'consumed') {
            this.redraw();
            return true;
        }
        return false;
    }

    // ── Touch support ─────────────────────────────────────────────────────────

    _attachTouchListeners() {
        if (this._touchHandler) return;
        this._touchStartY = null;
        this._touchHandler = (e) => this._onTouchEnd(e);
        this._touchStartHandler = (e) => { this._touchStartY = e.touches[0]?.clientY ?? null; };
        this.canvas.addEventListener('touchstart', this._touchStartHandler, { passive: true });
        this.canvas.addEventListener('touchend', this._touchHandler);
    }

    _detachTouchListeners() {
        if (!this._touchHandler) return;
        this.canvas.removeEventListener('touchstart', this._touchStartHandler);
        this.canvas.removeEventListener('touchend', this._touchHandler);
        this._touchHandler = null;
        this._touchStartHandler = null;
    }

    _onTouchEnd(event) {
        event.preventDefault();
        if (this.stack.length === 0) return;
        const touch = event.changedTouches[0];
        if (!touch) return;

        // Ignore swipes (> 15px vertical movement)
        if (this._touchStartY !== null && Math.abs(touch.clientY - this._touchStartY) > 15) return;

        const rect = this.canvas.getBoundingClientRect();
        const canvasX = (touch.clientX - rect.left) * (320 / rect.width);
        const canvasY = (touch.clientY - rect.top)  * (240 / rect.height);

        const w = this.stack[this.stack.length - 1];
        const result = w.onTouch?.(canvasX, canvasY);
        if (result === 'close') {
            this.popWidget();
        } else if (result === 'consumed') {
            this.redraw();
        }
    }
}
