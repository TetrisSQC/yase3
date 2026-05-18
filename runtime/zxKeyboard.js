/*
 * On-screen ZX Spectrum keyboard overlay.
 * Image (zxkeyb.png) backs a grid of transparent hit-zones; each cell
 * sends keyDown / keyUp messages to the emulator worker with the
 * matching Spectrum row/mask.
 *
 * Auto-shown in portrait orientation (configurable). Toggle exposed
 * via show()/hide()/toggle().
 *
 * Layout uses percentages of the image (480x192 = 2.5:1).
 */

import keybImageUrl from '../keyboard.jpg';

// row/mask values taken from runtime/keyboard.js SPECCY map.
const K = {
    ONE:[3,0x01], TWO:[3,0x02], THREE:[3,0x04], FOUR:[3,0x08], FIVE:[3,0x10],
    SIX:[4,0x10], SEVEN:[4,0x08], EIGHT:[4,0x04], NINE:[4,0x02], ZERO:[4,0x01],
    Q:[2,0x01], W:[2,0x02], E:[2,0x04], R:[2,0x08], T:[2,0x10],
    Y:[5,0x10], U:[5,0x08], I:[5,0x04], O:[5,0x02], P:[5,0x01],
    A:[1,0x01], S:[1,0x02], D:[1,0x04], F:[1,0x08], G:[1,0x10],
    H:[6,0x10], J:[6,0x08], K:[6,0x04], L:[6,0x02], ENTER:[6,0x01],
    CAPS:[0,0x01], Z:[0,0x02], X:[0,0x04], C:[0,0x08], V:[0,0x10],
    B:[7,0x10], N:[7,0x08], M:[7,0x04], SYMBOL:[7,0x02], SPACE:[7,0x01],
};

// Map ZX key names to DOM `KeyboardEvent.key` strings, so that taps on the
// on-screen keyboard drive OSD menu navigation while the emulator is paused.
// 7/8 already act as Up/Down inside MenuWidget; letter taps trigger the
// "A:" / "B:" hotkey shortcuts.
const OSD_KEY = {
    ONE:'1', TWO:'2', THREE:'3', FOUR:'4', FIVE:'5',
    SIX:'6', SEVEN:'7', EIGHT:'8', NINE:'9', ZERO:'0',
    Q:'q', W:'w', E:'e', R:'r', T:'t',
    Y:'y', U:'u', I:'i', O:'o', P:'p',
    A:'a', S:'s', D:'d', F:'f', G:'g',
    H:'h', J:'j', K:'k', L:'l',
    Z:'z', X:'x', C:'c', V:'v',
    B:'b', N:'n', M:'m',
    ENTER:'Enter', SPACE:' ',
};

// Each entry: [keyName, xPct, yPct, wPct, hPct].
// keyboard.jpg is 1926×817. Tight zones over the visible key body only —
// label bands intentionally not covered so debug labels sit on the key.
//
// Row Y centres measured from image:
//   Row 1 (numbers): y center ≈ 13%   → band 6–21
//   Row 2 (Q-P)    : y center ≈ 30%   → band 24–37
//   Row 3 (A-L)    : y center ≈ 48%   → band 42–56
//   Row 4 (Z row)  : y center ≈ 66%   → band 60–75
const layout = (() => {
    const out = [];

    // Y centres measured from rendered screenshot (keyboard at 2.83 aspect,
    // not raw 2.36 — the JS aspect-pin doesn't fire under all conditions, so
    // calibrate to the actually displayed rendering).
    //   Row 1 numbers  : y center ≈ 14% → top  8  height 12
    //   Row 2 Q-P      : y center ≈ 39% → top 33  height 12
    //   Row 3 A-L      : y center ≈ 64% → top 58  height 12
    //   Row 4 Z row    : y center ≈ 86% → top 80  height 14
    // Row 1 — numbers. Narrower keys, slightly lower.
    const top = ['ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE','ZERO'];
    const numX0 = 2, numW = 9.0;
    top.forEach((k,i) => out.push([k, numX0 + i*numW, 9, numW, 12]));

    // Row 2 — Q-P. Slightly lower per user feedback.
    const q = ['Q','W','E','R','T','Y','U','I','O','P'];
    const qX0 = 6, qW = 9.0;
    q.forEach((k,i) => out.push([k, qX0 + i*qW, 32, qW, 12]));

    // Row 3 — A-L + ENTER. Shifted up; letter keys wider (8→9%).
    const a = ['A','S','D','F','G','H','J','K','L'];
    const aX0 = 7, aW = 9.0;
    a.forEach((k,i) => out.push([k, aX0 + i*aW, 52, aW, 12]));
    out.push(['ENTER', 88, 52, 12, 12]);

    // Row 4 — CAPS, Z-M, SYMBOL, SPACE. CAPS+SPACE narrower, letters wider.
    out.push(['CAPS', 2, 75, 9.0, 14]);
    const z = ['Z','X','C','V','B','N','M'];
    const zX0 = 12, zW = 9.0;
    z.forEach((k,i) => out.push([k, zX0 + i*zW, 75, zW, 14]));
    out.push(['SYMBOL', 76, 75, 10.0, 14]);
    out.push(['SPACE',  87, 75, 12.0, 14]);
    return out;
})();

export class ZXKeyboard {
    constructor(container, emu, opts = {}) {
        this.container = container;
        this.emu = emu;
        this.worker = emu.worker;
        this.heldByPointer = new Map();  // pointerId → [row,mask]

        // Wrapper sits at the bottom; height auto via aspect-ratio.
        const ASPECT = 1926 / 817;
        this.wrap = document.createElement('div');
        this.wrap.style.cssText = [
            'position:absolute','left:0','right:0','bottom:0',
            'width:100%','aspect-ratio:1926/817',
            'background-image:url('+keybImageUrl+')',
            'background-size:100% 100%','background-repeat:no-repeat',
            'pointer-events:auto','touch-action:none',
            '-webkit-user-select:none','user-select:none',
            'display:none','z-index:42',
            'box-shadow:0 -4px 12px rgba(0,0,0,0.5)',
        ].join(';');
        container.appendChild(this.wrap);
        // Fallback: explicit pixel height in case `aspect-ratio` is overridden
        // by parent flex constraints. Recompute on every container resize so
        // the keyboard always matches the image proportions exactly.
        const syncHeight = () => {
            // Use container width (always laid out) rather than wrap.clientWidth
            // which can be 0 while wrap is display:none.
            const w = container.clientWidth;
            if (w > 0) this.wrap.style.height = (w / ASPECT) + 'px';
        };
        this._syncHeight = syncHeight;
        new ResizeObserver(syncHeight).observe(container);
        syncHeight();

        const debug = /[?&]keymapDebug=1/.test(window.location.search);
        for (const [name, x, y, w, h] of layout) {
            const [row, mask] = K[name];
            const cell = document.createElement('div');
            cell.dataset.key = name;
            cell.style.cssText = [
                'position:absolute',
                `left:${x}%`, `top:${y}%`,
                `width:${w}%`, `height:${h}%`,
                'background:transparent',
                'touch-action:none',
                'box-sizing:border-box',
                debug ? 'outline:1px solid rgba(255,40,40,0.9);background:rgba(255,80,80,0.18);color:#0f0;font:bold 11px monospace;display:flex;align-items:center;justify-content:center;text-shadow:0 0 3px #000,0 0 3px #000;' : '',
            ].join(';');
            if (debug) cell.textContent = name;
            cell.addEventListener('pointerdown', (ev) => {
                ev.preventDefault();
                cell.setPointerCapture(ev.pointerId);
                cell.style.background = 'rgba(255,255,255,0.25)';
                // OSD open: route to menu widget rather than the (paused) Spectrum.
                if (this.emu.osd?.isOpen) {
                    const k = OSD_KEY[name];
                    if (k) this.emu.osd.onKeyDown({ key: k, type: 'keydown' });
                    return;
                }
                this.heldByPointer.set(ev.pointerId, [row, mask]);
                this.worker.postMessage({message:'keyDown', row, mask});
            });
            const release = (ev) => {
                const held = this.heldByPointer.get(ev.pointerId);
                if (!held) {
                    cell.style.background = 'transparent';
                    try { cell.releasePointerCapture(ev.pointerId); } catch (e) {}
                    return;
                }
                this.heldByPointer.delete(ev.pointerId);
                cell.style.background = 'transparent';
                try { cell.releasePointerCapture(ev.pointerId); } catch (e) {}
                this.worker.postMessage({message:'keyUp', row: held[0], mask: held[1]});
            };
            cell.addEventListener('pointerup', release);
            cell.addEventListener('pointercancel', release);
            this.wrap.appendChild(cell);
        }

        // Layout coupling: when keyboard visible, reserve room at the
        // bottom of the container so the canvas doesn't sit behind it.
        // Use padding-bottom on the container which is read by the
        // canvas (height:100% → fills content box).
        this.visible = false;

        if (opts.autoPortrait !== false) {
            this.mql = window.matchMedia('(orientation: portrait)');
            const sync = () => { this.mql.matches ? this.show() : this.hide(); };
            this.mql.addEventListener?.('change', sync);
            sync();
        }
    }

    show() {
        if (this.visible) return;
        this.visible = true;
        this.wrap.style.display = 'block';
        // Reserve space at bottom of container so canvas shrinks above.
        requestAnimationFrame(() => {
            this._syncHeight?.();
            this.container.style.paddingBottom = this.wrap.offsetHeight + 'px';
            this.container.style.boxSizing = 'border-box';
            this._refreshLayout();
        });
        // Joystick overlay collides with keyboard at the bottom — suppress.
        this.emu.touchControls?.setEnabled(false);
    }
    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.wrap.style.display = 'none';
        this.container.style.paddingBottom = '';
        for (const [pid, [row, mask]] of this.heldByPointer) {
            this.worker.postMessage({message:'keyUp', row, mask});
        }
        this.heldByPointer.clear();
        this._refreshLayout();
        this.emu.touchControls?.setEnabled(true);
    }

    /**
     * Recompute the CRT overlay box now and again across subsequent frames.
     * Mirrors the fullscreen-recompute strategy in jsspeccy.js: the container's
     * `clientHeight` doesn't always reflect a fresh `padding-bottom` on the
     * first layout pass (Safari in particular needs ≥1 extra frame), so a
     * single rAF can leave the CRT canvas stretched against the old box.
     */
    _refreshLayout() {
        const run = () => this.emu.crtEffect?.applyAspectRatio?.();
        run();
        requestAnimationFrame(() => {
            run();
            requestAnimationFrame(run);
            setTimeout(run, 50);
            setTimeout(run, 200);
        });
    }
    toggle() { this.visible ? this.hide() : this.show(); }
}
