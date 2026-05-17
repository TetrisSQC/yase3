/*
 * Snapshot format support for the extended machine set.
 *
 * Wraps runtime/snapshot.js with ZXST machine ID handling for: SE (8),
 * Scorpion (9), Pentagon 512 (10), Pentagon 1024 (11), +3e (12),
 * TS2068 (13), TC2048 (14), TC2068 (15) — plus the existing 48/128/+3/Pentagon.
 *
 * Both SZX and .z80 v3 with extended hardware bytes are handled here.
 */

export {};
