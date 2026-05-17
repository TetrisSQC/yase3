/*
 * Touch overlay for Kempston joystick on touch devices.
 * Left: virtual D-pad (outer ring + draggable knob, thumb).
 * Right: A and B buttons.
 * Both fade in on first pointer activity, fade out after idle timeout.
 *
 * Emits a single byte to emu.setKempstonState:
 *   bit0=R bit1=L bit2=D bit3=U bit4=A(fire) bit5=B(fire2)
 */

const KEMP_R = 0x01, KEMP_L = 0x02, KEMP_D = 0x04, KEMP_U = 0x08;
const KEMP_A = 0x10, KEMP_B = 0x20;

const DPAD_OUTER = 140;          // px
const DPAD_KNOB  = 60;
const BTN_SIZE   = 72;
const DEADZONE   = 0.25;         // fraction of radius
const FADE_MS    = 1500;         // idle → hide

export class TouchControls {
    constructor(container, emu, opts = {}) {
        this.emu = emu;
        this.enabled = opts.enabled !== false;
        this.visible = false;
        this.fadeTimer = null;
        this.state = 0;
        this.dpadPointer = null;
        this.aPointer = null;
        this.bPointer = null;

        this.root = document.createElement('div');
        this.root.style.cssText = [
            'position:absolute','inset:0','pointer-events:none',
            'opacity:0','transition:opacity 220ms ease',
            'z-index:40','touch-action:none',
            '-webkit-user-select:none','user-select:none',
        ].join(';');
        container.appendChild(this.root);

        this._buildDpad();
        this._buildButtons();

        // Pointer activity anywhere in the container reveals controls.
        container.addEventListener('pointerdown', () => this._poke(), { passive: true });
        container.addEventListener('pointermove', () => { if (this.visible) this._poke(); }, { passive: true });

        // Auto-hide controls themselves once nothing held.
        this._installFadeOnRelease();
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (!this.enabled) {
            this._hideNow();
            this._resetState();
            this.root.style.display = 'none';
        } else {
            this.root.style.display = '';
        }
    }

    _buildDpad() {
        const wrap = document.createElement('div');
        wrap.style.cssText = [
            'position:absolute','left:18px','bottom:18px',
            `width:${DPAD_OUTER}px`,`height:${DPAD_OUTER}px`,
            'border-radius:50%',
            'background:rgba(255,255,255,0.10)',
            'border:2px solid rgba(255,255,255,0.45)',
            'pointer-events:auto','touch-action:none',
            'box-shadow:0 0 24px rgba(0,0,0,0.35)',
        ].join(';');
        this.root.appendChild(wrap);

        const knob = document.createElement('div');
        knob.style.cssText = [
            'position:absolute',
            `width:${DPAD_KNOB}px`,`height:${DPAD_KNOB}px`,
            `left:${(DPAD_OUTER - DPAD_KNOB) / 2}px`,
            `top:${(DPAD_OUTER - DPAD_KNOB) / 2}px`,
            'border-radius:50%',
            'background:rgba(255,255,255,0.55)',
            'border:2px solid rgba(255,255,255,0.85)',
            'transition:transform 60ms linear',
            'pointer-events:none',
        ].join(';');
        wrap.appendChild(knob);

        this.dpadEl = wrap;
        this.knobEl = knob;

        const centerKnob = (dx, dy) => {
            knob.style.transform = `translate(${dx}px,${dy}px)`;
        };

        const onMove = (clientX, clientY) => {
            const r = wrap.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top  + r.height / 2;
            const radius = r.width / 2;
            let dx = clientX - cx;
            let dy = clientY - cy;
            const mag = Math.hypot(dx, dy);
            const maxOff = radius - DPAD_KNOB / 2;
            if (mag > maxOff) {
                dx = dx / mag * maxOff;
                dy = dy / mag * maxOff;
            }
            centerKnob(dx, dy);

            const nx = dx / maxOff;
            const ny = dy / maxOff;
            const dead = DEADZONE;
            let bits = 0;
            if (nx >  dead) bits |= KEMP_R;
            if (nx < -dead) bits |= KEMP_L;
            if (ny >  dead) bits |= KEMP_D;
            if (ny < -dead) bits |= KEMP_U;
            this._setDir(bits);
        };

        wrap.addEventListener('pointerdown', (ev) => {
            if (this.dpadPointer !== null) return;
            this.dpadPointer = ev.pointerId;
            wrap.setPointerCapture(ev.pointerId);
            this._poke();
            onMove(ev.clientX, ev.clientY);
        });
        wrap.addEventListener('pointermove', (ev) => {
            if (ev.pointerId !== this.dpadPointer) return;
            onMove(ev.clientX, ev.clientY);
        });
        const release = (ev) => {
            if (ev.pointerId !== this.dpadPointer) return;
            this.dpadPointer = null;
            try { wrap.releasePointerCapture(ev.pointerId); } catch (e) {}
            centerKnob(0, 0);
            this._setDir(0);
        };
        wrap.addEventListener('pointerup', release);
        wrap.addEventListener('pointercancel', release);
        wrap.addEventListener('pointerleave', (ev) => {
            // Pointer capture should keep events flowing, but fall back to
            // release if capture was dropped (some browsers).
            if (ev.pointerId === this.dpadPointer && !wrap.hasPointerCapture?.(ev.pointerId)) {
                release(ev);
            }
        });
    }

    _buildButtons() {
        const makeBtn = (label, bit, bottom, right) => {
            const btn = document.createElement('div');
            btn.textContent = label;
            btn.style.cssText = [
                'position:absolute',
                `right:${right}px`,`bottom:${bottom}px`,
                `width:${BTN_SIZE}px`,`height:${BTN_SIZE}px`,
                'border-radius:50%',
                'background:rgba(255,255,255,0.20)',
                'border:2px solid rgba(255,255,255,0.55)',
                'color:#fff','font:bold 28px Arial,Helvetica,sans-serif',
                'display:flex','align-items:center','justify-content:center',
                'pointer-events:auto','touch-action:none',
                'box-shadow:0 0 18px rgba(0,0,0,0.35)',
                '-webkit-tap-highlight-color:transparent',
            ].join(';');
            this.root.appendChild(btn);

            const press = (ev) => {
                if (this[bit === KEMP_A ? 'aPointer' : 'bPointer'] !== null) return;
                this[bit === KEMP_A ? 'aPointer' : 'bPointer'] = ev.pointerId;
                btn.setPointerCapture(ev.pointerId);
                btn.style.background = 'rgba(255,255,255,0.45)';
                this._setBtn(bit, true);
                this._poke();
            };
            const release = (ev) => {
                const slot = bit === KEMP_A ? 'aPointer' : 'bPointer';
                if (ev.pointerId !== this[slot]) return;
                this[slot] = null;
                try { btn.releasePointerCapture(ev.pointerId); } catch (e) {}
                btn.style.background = 'rgba(255,255,255,0.20)';
                this._setBtn(bit, false);
            };
            btn.addEventListener('pointerdown', press);
            btn.addEventListener('pointerup', release);
            btn.addEventListener('pointercancel', release);
            return btn;
        };

        // B sits left of A, A below-right (typical gamepad layout).
        this.btnA = makeBtn('A', KEMP_A, 24,  24);
        this.btnB = makeBtn('B', KEMP_B, 96, 110);
    }

    _setDir(bits) {
        this.state = (this.state & ~(KEMP_R | KEMP_L | KEMP_U | KEMP_D)) | (bits & 0x0f);
        this._flush();
    }
    _setBtn(bit, on) {
        if (on) this.state |= bit; else this.state &= ~bit;
        this._flush();
    }
    _flush() {
        if (!this.enabled) return;
        if (this.emu && typeof this.emu.setKempstonState === 'function') {
            this.emu.setKempstonState(this.state);
        }
    }
    _resetState() {
        this.state = 0;
        this.dpadPointer = this.aPointer = this.bPointer = null;
        this._flush();
    }

    _poke() {
        if (!this.enabled) return;
        if (!this.visible) {
            this.visible = true;
            this.root.style.opacity = '0.55';
        }
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
        this.fadeTimer = setTimeout(() => this._maybeHide(), FADE_MS);
    }

    _installFadeOnRelease() {
        // Fade tick checks every FADE_MS; only hides when no button held.
    }

    _maybeHide() {
        if (this.dpadPointer !== null || this.aPointer !== null || this.bPointer !== null) {
            // Still held — defer.
            this.fadeTimer = setTimeout(() => this._maybeHide(), FADE_MS);
            return;
        }
        this._hideNow();
    }
    _hideNow() {
        this.visible = false;
        this.root.style.opacity = '0';
    }
}
