/*
 * OSD drawing primitives. Solid filled rectangles, 8x8
 * bitmap text from the Spectrum ROM font, cyan highlight bar, white-on-black
 * by default.
 *
 * The font is loaded from the 48K Spectrum ROM (bytes 0x3D00..0x3FFF in the
 * shipped static/roms/48.rom) at first instantiation. The 96 glyphs cover
 * ASCII 32..127. While the font is still loading, drawText() falls back to
 * solid blocks.
 *
 * All coordinates are in OSD canvas pixels, which match the Spectrum native
 * 320x240 framebuffer 1:1 — CSS scales both canvases identically.
 */

const SPECTRUM_PALETTE = [
    '#000000', '#0000d7', '#d70000', '#d700d7',
    '#00d700', '#00d7d7', '#d7d700', '#d7d7d7',
    '#000000', '#0000ff', '#ff0000', '#ff00ff',
    '#00ff00', '#00ffff', '#ffff00', '#ffffff',
];

export const COLOUR = {
    BLACK:         0,
    BLUE:          1,
    RED:           2,
    MAGENTA:       3,
    GREEN:         4,
    CYAN:          5,
    YELLOW:        6,
    WHITE:         7,
    BRIGHT_BLACK:  8,
    BRIGHT_BLUE:   9,
    BRIGHT_RED:   10,
    BRIGHT_MAG:   11,
    BRIGHT_GREEN: 12,
    BRIGHT_CYAN:  13,
    BRIGHT_YELLOW:14,
    BRIGHT_WHITE: 15,
};

const FONT_URL_DEFAULT = 'jsspeccy/roms/48.rom';
const FONT_OFFSET = 0x3d00;
const FONT_LENGTH = 96 * 8;
let fontCache = null;
let fontPromise = null;

export async function loadOsdFont(baseUrl = '') {
    if (fontCache) return fontCache;
    if (!fontPromise) {
        fontPromise = (async () => {
            const url = new URL(FONT_URL_DEFAULT, baseUrl || document.baseURI);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`loadOsdFont: ${resp.status}`);
            const rom = new Uint8Array(await resp.arrayBuffer());
            fontCache = rom.subarray(FONT_OFFSET, FONT_OFFSET + FONT_LENGTH);
            return fontCache;
        })();
    }
    return fontPromise;
}

export class OsdRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;
        this.font = null;

        // Kick off async font load; redraws after this complete will use the
        // bitmap glyphs. The OSD callers should call osd.redraw() once.
        loadOsdFont().then((font) => {
            this.font = font;
        }).catch((err) => {
            console.warn('OSD font load failed (falling back to blocks):', err);
        });
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /** Fill rectangle with a Spectrum palette index (0..15). */
    fillRect(x, y, w, h, colour) {
        this.ctx.fillStyle = SPECTRUM_PALETTE[colour & 0x0f];
        this.ctx.fillRect(x, y, w, h);
    }

    /** Single-pixel-wide border rectangle. */
    strokeRect(x, y, w, h, colour) {
        this.ctx.fillStyle = SPECTRUM_PALETTE[colour & 0x0f];
        this.ctx.fillRect(x, y, w, 1);
        this.ctx.fillRect(x, y + h - 1, w, 1);
        this.ctx.fillRect(x, y, 1, h);
        this.ctx.fillRect(x + w - 1, y, 1, h);
    }

    /**
     * Draw an 8x8 glyph at (px, py). codepoint is the ASCII code.
     * ink = palette index 0..15, paper = palette index or -1 (transparent).
     */
    drawChar(px, py, codepoint, ink, paper) {
        if (paper >= 0) this.fillRect(px, py, 8, 8, paper);
        if (!this.font) {
            // Pre-font fallback: filled block so the layout is still visible.
            this.fillRect(px + 1, py + 1, 6, 6, ink);
            return;
        }
        if (codepoint < 32 || codepoint > 127) codepoint = 32;
        const fontIndex = (codepoint - 32) * 8;
        this.ctx.fillStyle = SPECTRUM_PALETTE[ink & 0x0f];
        for (let row = 0; row < 8; row++) {
            const bits = this.font[fontIndex + row];
            for (let col = 0; col < 8; col++) {
                if (bits & (0x80 >> col)) {
                    this.ctx.fillRect(px + col, py + row, 1, 1);
                }
            }
        }
    }

    /**
     * Draw a string left-anchored at (px, py). Returns the x coord past the
     * last glyph drawn.
     */
    drawText(px, py, text, ink = COLOUR.WHITE, paper = -1) {
        let x = px;
        for (let i = 0; i < text.length; i++) {
            this.drawChar(x, py, text.charCodeAt(i), ink, paper);
            x += 8;
        }
        return x;
    }

    /**
     * Draw a string right-anchored so its end is at px.
     */
    drawTextRight(px, py, text, ink = COLOUR.WHITE, paper = -1) {
        return this.drawText(px - text.length * 8, py, text, ink, paper);
    }

    /**
     * Dialog frame:
     *   - body filled black
     *   - 1 px white outline
     *   - title row (8 px) with white text on black
     *   - Sinclair rainbow flag at top-right (4 bright stripes, 8 px each,
     *     diagonally shifted left by 1 px per scanline → top-right-to-
     *     bottom-left slope, matches widget_draw_speccy_rainbow_bar in
     *     ui/widget/widget.c).
     */
    drawDialog(x, y, w, h, title) {
        // Body: bright (pure) white. Title strip (top 9 px): black with white text.
        this.fillRect(x, y, w, h, COLOUR.BRIGHT_WHITE);
        this.strokeRect(x, y, w, h, COLOUR.BLACK);
        if (title) {
            this.fillRect(x + 1, y + 1, w - 2, 9, COLOUR.BLACK);
            this.drawText(x + 4, y + 2, title, COLOUR.BRIGHT_WHITE, -1);
            this._drawRainbowFlag(x + w - 33, y + 1);
        }
    }

    /**
     * 4-stripe Sinclair rainbow with downward-left diagonal. Reproduces the
     * 4-stripe Sinclair rainbow rendered line-by-line:
     * each of 8 scanlines emits four 8-px stripes (bright red / yellow / green
     * / cyan), with the starting x decremented by 1 per scanline.
     */
    _drawRainbowFlag(x, y) {
        const colours = [
            COLOUR.BRIGHT_RED, COLOUR.BRIGHT_YELLOW,
            COLOUR.BRIGHT_GREEN, COLOUR.BRIGHT_CYAN,
        ];
        let curX = x - 8;
        for (let row = 0; row < 9; row++) {
            for (let s = 0; s < 4; s++) {
                this.fillRect(curX + s * 8, y + row, 8, 1, colours[s]);
            }
            curX -= 1;
        }
    }
}
