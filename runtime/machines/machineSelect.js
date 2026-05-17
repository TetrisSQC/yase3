/*
 * Drives the wasm core into a given machine configuration.
 *
 * One call to selectMachine() does, in order:
 *   1. configureMachine() — frame timing, contention, paging mode, AY/SCLD
 *      flags, reset state.
 *   2. Loads each romPages[i].data into its target wasm RAM/ROM slot.
 *   3. Re-populates the PeriphBus from MachineDef.periph[].
 *
 * The wasm core's reset() runs at the end of configureMachine, so register
 * state and page maps are valid the moment this function returns.
 *
 * ROM data is supplied by the caller (worker fetches it) — this module stays
 * synchronous, no I/O.
 */

import { getMachine } from './index.js';

/**
 * @param {Object} core      wasm core exports (from instantiateStreaming).
 * @param {Uint8Array} memoryData  view onto core.memory.buffer.
 * @param {Object} periphBus PeriphBus instance.
 * @param {number} machineId
 * @param {Map<string, Uint8Array>} [roms]  Filename → bytes. Required if the
 *                                          machine def names ROMs not yet
 *                                          loaded into wasm memory.
 */
export function selectMachine(core, memoryData, periphBus, machineId, roms) {
    const def = getMachine(machineId);
    if (!def) {
        throw new Error(`selectMachine: unknown machine id ${machineId}`);
    }

    // Encode the various flags into the bit positions configureMachine expects.
    const contendedMask = def.contendedPages.reduce((acc, p) => acc | (1 << p), 0);
    const contentionPattern = (
        def.contentionPattern === '65432100' ? 1 :
        def.contentionPattern === '76543210' ? 2 : 0
    );
    const pagingMode = PAGING_MODE_IDS[def.pagingMode];
    if (pagingMode === undefined) {
        throw new Error(`selectMachine: unknown pagingMode '${def.pagingMode}'`);
    }

    const rom0 = def.romPages[0]?.wasmPage ?? 0;
    const rom1 = def.romPages[1]?.wasmPage ?? rom0;

    const betadisk = def.periph.some((p) => p.type === 'beta128') ? 1 : 0;
    const ay = def.ay && def.ay !== 'none' ? 1 : 0;
    const scld = def.timex ? 1 : 0;

    const r = def.resetState.readMap;
    const w = def.resetState.writeMap;
    const resetReadPacked  = (r[0] & 0xff) | ((r[1] & 0xff) << 8) | ((r[2] & 0xff) << 16) | ((r[3] & 0xff) << 24);
    const resetWritePacked = (w[0] & 0xff) | ((w[1] & 0xff) << 8) | ((w[2] & 0xff) << 16) | ((w[3] & 0xff) << 24);

    core.configureMachine(
        def.id,
        def.frameTstates,
        def.firstScreenTstate,
        def.scanlineTstates,
        def.borderTimeMask,
        contentionPattern,
        contendedMask,
        pagingMode,
        rom0,
        rom1,
        betadisk,
        ay,
        scld,
        resetReadPacked >>> 0,
        resetWritePacked >>> 0,
        def.resetState.pagingLocked ? 1 : 0,
        def.resetState.screenPage
    );

    // Spectrum 16K: pre-fill the open-bus slot with 0xff so reads of the
    // unmapped 32 K upper region return the floating-bus default.
    if (def.openBusSlot !== undefined) {
        const base = core.MACHINE_MEMORY + def.openBusSlot * 0x4000;
        memoryData.fill(0xff, base, base + 0x4000);
    }

    // Optional per-machine extra ROM slots: Scorpion's rom2 (selected by
    // 0x1ffd bit 1) and the beta M1-trap target ROM. Fall back to rom1 and
    // slot 68 (trdos.rom) for machines that don't define them.
    if (core.setExtraRomPages) {
        core.setExtraRomPages(def.rom2Page ?? rom1, def.betaRomPage ?? 68);
    }

    // Timex SCLD paging support: pre-build a dock-blank slot (0xff) and an
    // exrom slot (tc2068-1.rom 8K repeated in both halves). When HSR routes
    // a 16K bank to dock/exrom, wasm switches the bank's read map to one of
    // these synthesised slots. See applySCLDMemoryMap in core.ts.in.
    const SCLD_DOCK_BLANK_SLOT = 82;
    const SCLD_EXROM_SLOT = 81;
    if (def.timex && core.setSCLDPagingSlots && roms) {
        const base = core.MACHINE_MEMORY;
        // dock-blank: 16K of 0xff
        memoryData.fill(0xff, base + SCLD_DOCK_BLANK_SLOT * 0x4000,
                              base + (SCLD_DOCK_BLANK_SLOT + 1) * 0x4000);
        // exrom: tc2068-1.rom 8K, repeated twice to fill the 16K slot
        const exromSrc = roms.get('tc2068-1.rom');
        if (exromSrc) {
            memoryData.set(exromSrc, base + SCLD_EXROM_SLOT * 0x4000);
            memoryData.set(exromSrc, base + SCLD_EXROM_SLOT * 0x4000 + 0x2000);
        } else {
            // No exrom — fill with 0xff so HSR-to-exrom reads are at least benign.
            memoryData.fill(0xff, base + SCLD_EXROM_SLOT * 0x4000,
                                  base + (SCLD_EXROM_SLOT + 1) * 0x4000);
        }
        core.setSCLDPagingSlots(SCLD_DOCK_BLANK_SLOT, SCLD_EXROM_SLOT);
    } else if (core.setSCLDPagingSlots) {
        // Non-Timex: zero out so any stray paging call lands in slot 0.
        core.setSCLDPagingSlots(0, 0);
    }

    if (roms) {
        for (const slot of def.romPages) {
            const data = roms.get(slot.file);
            if (data) {
                memoryData.set(data, core.MACHINE_MEMORY + slot.wasmPage * 0x4000);
            }
        }
    }

    periphBus.clear();
    for (const p of def.periph) {
        periphBus.register(p);
    }

    // Enable wasm-to-host port forwarding if any peripheral needs JS-side
    // emulation (disk controllers + similar). 48K-only machines keep it off
    // so the wasm core never makes the host call.
    const needsHost = def.periph.some((p) => HOST_PORT_TYPES.has(p.type));
    core.setHostPortsEnabled(needsHost ? 1 : 0);
}

const HOST_PORT_TYPES = new Set([
    'upd765', 'wd1770', 'beta128', 'plusd', 'disciple', 'opus',
]);

const PAGING_MODE_IDS = {
    none:         0,
    '128':        1,
    plus3:        2,
    plus3e:       3,
    pentagon128:  4,
    pentagon512:  5,
    pentagon1024: 6,
    scorpion:     7,
    se:           8,
    timexScld:    9,
};
