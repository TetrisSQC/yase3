/*
 * jnext WASM bridge. Loads the emscripten-built jnext.wasm module and
 * drives it from a host page or dedicated worker.
 *
 * The bridge is intentionally minimal: it exposes the same surface the
 * main jsspeccy emulator exposes (start / stop / runFrame / etc.) so
 * future code can swap the two backends behind a common API.
 *
 * Expected layout in dist/:
 *   dist/jnext/jnext.js   — emscripten loader (ES module, default export)
 *   dist/jnext/jnext.wasm — wasm binary
 *
 * The SD-card image must be uploaded by the host before init():
 *   const sd = await fetch('/path/to/nextzxos.img').then(r => r.arrayBuffer());
 *   await jnext.attachSDCard(new Uint8Array(sd));
 *   jnext.init();
 */

const JNEXT_MODULE_URL = 'jnext/jnext.js';

export class JnextBridge {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.module = null;
        this.running = false;
        this._frameTimer = null;
    }

    /** Loads the wasm module. Call once. */
    async load() {
        const factory = (await import(/* @vite-ignore */ JNEXT_MODULE_URL)).default;
        this.module = await factory({
            // emscripten options. Locate wasm via the same dir as the JS.
            locateFile: (p) => `jnext/${p}`,
        });
        this._wrap();
    }

    _wrap() {
        const m = this.module;
        this.init        = m.cwrap('jnext_init',       null, []);
        this.reset       = m.cwrap('jnext_reset',      null, []);
        this.stepFrame   = m.cwrap('jnext_step_frame', null, []);
        this.keyDown     = m.cwrap('jnext_keydown',    null, ['number']);
        this.keyUp       = m.cwrap('jnext_keyup',      null, ['number']);
        this._frameBuf   = m.cwrap('jnext_get_frame_buffer', 'number', ['number','number']);
        this._audioBuf   = m.cwrap('jnext_get_audio_buffer', 'number', ['number']);
        this._setSD      = m.cwrap('jnext_set_sd_card_bytes', null, ['number','number']);
    }

    /** Upload SD-card image bytes into the wasm heap and hand them to jnext. */
    attachSDCard(bytes) {
        const m = this.module;
        const ptr = m._malloc(bytes.length);
        m.HEAPU8.set(bytes, ptr);
        this._setSD(ptr, bytes.length);
        // jnext copies the bytes into its own buffer, so we can free here.
        m._free(ptr);
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = () => {
            if (!this.running) return;
            this.stepFrame();
            this._blit();
            this._frameTimer = setTimeout(loop, 20);     // 50 Hz target
        };
        loop();
    }
    stop() {
        this.running = false;
        if (this._frameTimer) clearTimeout(this._frameTimer);
        this._frameTimer = null;
    }

    _blit() {
        const m = this.module;
        const wPtr = m._malloc(4);
        const hPtr = m._malloc(4);
        const fbPtr = this._frameBuf(wPtr, hPtr);
        const w = m.HEAPU32[wPtr >> 2];
        const h = m.HEAPU32[hPtr >> 2];
        m._free(wPtr);
        m._free(hPtr);

        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        // Pull RGBA bytes out of the wasm heap.
        const src = m.HEAPU8.subarray(fbPtr, fbPtr + w * h * 4);
        const img = new ImageData(new Uint8ClampedArray(src), w, h);
        this.ctx.putImageData(img, 0, 0);
    }
}
