/*
 * On-screen-display (OSD) overlay menu.
 *
 * 8x8 bitmap font, cyan highlight, drawn on a 2D canvas stacked above the
 * emulator framebuffer canvas. Opens on F1, pauses emulation, captures
 * keyboard until closed.
 *
 * Implementation lives in:
 *   - osd.js          — Osd class (lifecycle, input, modal stack)
 *   - render.js       — primitives (rect, printString, font)
 *   - menuTree.js     — declarative menu tree
 *   - widgets/        — individual widgets (menu, fileSelector, query, options)
 */

export {};
