/*
 * CRT post-processing effect via WebGL.
 *
 * Creates a WebGL canvas that sits on top of the emulator's 2D canvas
 * (zIndex 5, below the OSD at 50) and applies screen effects each frame.
 *
 * Effects (matching TCrtTextureMaterial from crt.pas):
 *   scanlines  — darken alternate scanlines
 *   vignette   — darken corners / edges
 *   distortion — barrel distortion (CRT screen curve)
 *   flicker    — time-based brightness oscillation
 *   pixelshift — sub-pixel RGB lateral offset (phosphor dot effect)
 */

const VS_SRC = `
attribute vec2 aPos;
varying   vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    vUV.y = 1.0 - vUV.y;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_SRC = `
precision mediump float;

uniform sampler2D uTex;
uniform vec2      uResolution;
uniform float     uTime;
uniform float     uScanlines;
uniform float     uVignette;
uniform float     uDistortion;
uniform float     uFlicker;
uniform float     uPixelshift;

varying vec2 vUV;

vec2 barrel(vec2 uv) {
    vec2 cc   = uv - 0.5;
    float d   = dot(cc, cc) * 0.12;
    return uv + cc * (1.0 + d) * d;
}

void main() {
    vec2 uv = vUV;

    if (uDistortion > 0.5) {
        uv = barrel(uv);
        // Discard a one-texel-wide rim so the leftmost / rightmost framebuffer
        // column (which is border colour) doesn't get clamp-replicated by the
        // sampler into a thin vertical strip when uv lands just barely inside
        // [0, 1]. Source framebuffer is 320×240, so 1/320 ≈ 0.0031.
        if (uv.x < 0.0032 || uv.x > 0.9968 || uv.y < 0.0042 || uv.y > 0.9958) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
    }

    vec4 color;
    if (uPixelshift > 0.5) {
        float shift = 1.5 / uResolution.x;
        color.r = texture2D(uTex, uv + vec2( shift, 0.0)).r;
        color.g = texture2D(uTex, uv                   ).g;
        color.b = texture2D(uTex, uv - vec2( shift, 0.0)).b;
        color.a = 1.0;
    } else {
        color = texture2D(uTex, uv);
    }

    if (uScanlines > 0.5) {
        float line = mod(gl_FragCoord.y, 2.0);
        color.rgb *= 0.72 + 0.28 * step(1.0, line);
    }

    if (uVignette > 0.5) {
        vec2  vp  = uv * (1.0 - uv.yx);
        float vig = pow(clamp(vp.x * vp.y * 16.0, 0.0, 1.0), 0.3);
        color.rgb *= vig;
    }

    if (uFlicker > 0.5) {
        color.rgb *= 1.0 - 0.015 * sin(uTime * 47.3);
    }

    gl_FragColor = color;
}`;

export class CRTEffect {
    /**
     * @param {HTMLElement}      container    appContainer — for positioning
     * @param {HTMLCanvasElement} sourceCanvas emulator 2D canvas (the draw source)
     */
    constructor(container, sourceCanvas) {
        this.sourceCanvas = sourceCanvas;
        this.settings = {
            scanlines: false, vignette: false,
            distortion: false, flicker: false, pixelshift: false,
            // Display aspect ratio for the visible canvas area. '4 / 3' is
            // the native Spectrum CRT ratio; 'stretch' lets the surrounding
            // container fully decide (fills 16:9 etc).
            aspectRatio: '4 / 3',
        };
        this.time = 0;

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.display = 'none';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.imageRendering = 'pixelated';
        this.canvas.style.zIndex = '5';
        container.appendChild(this.canvas);

        const gl = this.canvas.getContext('webgl')
                || this.canvas.getContext('experimental-webgl');
        this.gl = gl;

        if (!gl) {
            console.warn('CRTEffect: WebGL not available');
            return;
        }

        this._program = this._buildProgram(gl, VS_SRC, FS_SRC);
        if (!this._program) return;

        // Fullscreen quad
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        this._quadBuf = buf;

        // Texture for source canvas
        this._tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Uniforms
        const p = this._program;
        this._uTex        = gl.getUniformLocation(p, 'uTex');
        this._uResolution = gl.getUniformLocation(p, 'uResolution');
        this._uTime       = gl.getUniformLocation(p, 'uTime');
        this._uScanlines  = gl.getUniformLocation(p, 'uScanlines');
        this._uVignette   = gl.getUniformLocation(p, 'uVignette');
        this._uDistortion = gl.getUniformLocation(p, 'uDistortion');
        this._uFlicker    = gl.getUniformLocation(p, 'uFlicker');
        this._uPixelshift = gl.getUniformLocation(p, 'uPixelshift');
        this._aPos        = gl.getAttribLocation(p, 'aPos');

        this.applyAspectRatio();
        this._syncSize();

        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this._syncSize());
            this._ro.observe(sourceCanvas);
            this._ro.observe(container);
        }
        window.addEventListener('resize', () => this._syncSize());
    }

    get isActive() {
        const s = this.settings;
        return s.scanlines || s.vignette || s.distortion || s.flicker || s.pixelshift;
    }

    setSettings(patch) {
        Object.assign(this.settings, patch);
        this.canvas.style.display = this.isActive ? 'block' : 'none';
        if ('aspectRatio' in patch) this.applyAspectRatio();
    }

    /**
     * Push the configured aspect-ratio onto the emulator canvas (and this
     * overlay's CSS box, since they share layout). 'stretch' clears the
     * constraint so the canvas fills its parent container without a fixed
     * ratio (object-fit:fill).
     */
    applyAspectRatio() {
        const v = this.settings.aspectRatio;
        const src = this.sourceCanvas;
        // CSS aspect-ratio is ignored when both width and height are set, so
        // we clear them and compute the visible box in pixels from the parent
        // container + the chosen ratio. Re-runs on every resize.
        src.style.aspectRatio = '';
        this.canvas.style.aspectRatio = '';
        if (v === 'stretch') {
            src.style.width    = '100%';
            src.style.height   = '100%';
            src.style.objectFit = 'fill';
            this.canvas.style.objectFit = 'fill';
        } else {
            // Parse "W / H" into numbers; fall back to 4/3 on parse failure.
            const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
            const aw = m ? parseFloat(m[1]) : 4;
            const ah = m ? parseFloat(m[2]) : 3;
            this._aspectW = aw;
            this._aspectH = ah;
            src.style.objectFit = 'contain';
            this.canvas.style.objectFit = 'contain';
            this._applyComputedSize();
        }
        this._syncSize();
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => this._syncSize());
        }
    }

    /** Compute the canvas display box in CSS pixels for the active ratio. */
    _applyComputedSize() {
        const src = this.sourceCanvas;
        const parent = src.parentElement;
        if (!parent || !this._aspectW) return;
        const pw = parent.clientWidth;
        const ph = parent.clientHeight;
        if (pw === 0 || ph === 0) return;
        const ratio = this._aspectW / this._aspectH;
        let w, h;
        if (pw / ph > ratio) {
            h = ph;
            w = h * ratio;
        } else {
            w = pw;
            h = w / ratio;
        }
        src.style.width  = `${Math.floor(w)}px`;
        src.style.height = `${Math.floor(h)}px`;
    }

    render() {
        const gl = this.gl;
        if (!gl || !this._program || !this.isActive) return;

        this.time += 1 / 50;

        // Upload source canvas as texture
        gl.bindTexture(gl.TEXTURE_2D, this._tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.sourceCanvas);

        gl.useProgram(this._program);

        // Uniforms
        gl.uniform1i(this._uTex, 0);
        gl.uniform2f(this._uResolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this._uTime,       this.time);
        gl.uniform1f(this._uScanlines,  this.settings.scanlines  ? 1 : 0);
        gl.uniform1f(this._uVignette,   this.settings.vignette   ? 1 : 0);
        gl.uniform1f(this._uDistortion, this.settings.distortion ? 1 : 0);
        gl.uniform1f(this._uFlicker,    this.settings.flicker    ? 1 : 0);
        gl.uniform1f(this._uPixelshift, this.settings.pixelshift ? 1 : 0);

        // Draw quad
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
        gl.enableVertexAttribArray(this._aPos);
        gl.vertexAttribPointer(this._aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _syncSize() {
        // Recompute the main canvas box for the active aspect-ratio every
        // resize. 'stretch' mode skips this — it leaves width/height at 100%.
        if (this._aspectW && this.settings.aspectRatio !== 'stretch') {
            this._applyComputedSize();
        }
        const main = this.sourceCanvas;
        const rect = main.getBoundingClientRect();
        if (rect.width === 0) return;
        // Use bounding rects relative to the offset parent so positioning is
        // sub-pixel-accurate. main.offsetTop / offsetLeft are integer-rounded
        // and can be off by ≤1 px from the real flex-centered position,
        // which manifests as a 1-px strip of the underlying source canvas
        // bleeding past the CRT overlay (visible as a border-colour line on
        // the left edge when the barrel distortion makes the rest black).
        const parent = this.canvas.offsetParent || main.offsetParent;
        let dx = 0;
        let dy = 0;
        if (parent) {
            const pRect = parent.getBoundingClientRect();
            dx = rect.left - pRect.left;
            dy = rect.top  - pRect.top;
        } else {
            dx = main.offsetLeft;
            dy = main.offsetTop;
        }
        this.canvas.style.top    = `${dy}px`;
        this.canvas.style.left   = `${dx}px`;
        this.canvas.style.width  = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        // Match display pixel size so scanlines are 1px at display resolution
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width  * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width  = w;
            this.canvas.height = h;
            this.gl?.viewport(0, 0, w, h);
        }
    }

    _buildProgram(gl, vsSrc, fsSrc) {
        const vs = this._compile(gl, gl.VERTEX_SHADER, vsSrc);
        const fs = this._compile(gl, gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('CRTEffect: shader link failed:', gl.getProgramInfoLog(prog));
            return null;
        }
        return prog;
    }

    _compile(gl, type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error('CRTEffect: shader compile failed:', gl.getShaderInfoLog(sh));
            return null;
        }
        return sh;
    }
}
