/*
 * Cycle-accurate tape edge engine.
 *
 * Parses TZX/TAP into a stream of { deltaTstate, levelFlags } edges, fed into
 * the wasm core's tape edge buffer. The ULA reads the EAR bit from port 0xfe;
 * no Z80 ROM trap is required — standard ROM loaders, turbo loaders, Speedlock,
 * Alkatraz, etc. all work.
 *
 * Implementation:
 *   - tzx.js   — TZX block state machine (port of libspectrum tape_block.c).
 *   - tap.js   — TAP (raw block) decoder.
 *   - engine.js — feeds edges into wasm, handles pause/resume, stop bits.
 *
 * The existing trap-based fast-load (runtime/tape.js) remains as an optional
 * accelerator toggle.
 */

export {};
