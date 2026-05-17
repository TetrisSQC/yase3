/*
 * Romantic Robot Multiface (One / 128 / 3) — game-snapshot cartridge.
 *
 * Ported from Fuse 1.8.0 peripherals/multiface.c.
 *
 * Hardware:
 *   - 8 KB ROM + 8 KB RAM mapped over slot 0 (0x0000-0x3fff) via /ROMCS
 *   - Physical red button → pulls /NMI on the Z80 → CPU enters 0x0066
 *   - Multiface intercepts the NMI vector by paging itself in on M1 fetch
 *     at 0x0066. This is implemented in wasm (multifaceEnabled flag + NMI
 *     handler in runUntil).
 *
 * Page-in / page-out is port-based (variant-specific decode):
 *   MF One : ports masked 0x72 / matched 0x12 (bits 1,4). A7=1 → page in,
 *            A7=0 → page out.
 *   MF 128 : ports masked 0x72 / matched 0x32 (bits 1,4,5). Same A7 rule.
 *   MF 3   : ports masked 0x72 / matched 0x32, but A7 reversed:
 *            A7=1 → page out, A7=0 → page in.
 *
 * Slot used for the synthesised 16 K (ROM low 8 K + RAM high 8 K): 85.
 */

const MULTIFACE_SLOT = 85;
const ROM_SIZE = 0x2000;
const RAM_SIZE = 0x2000;

export const MF_VARIANT_1   = 1;
export const MF_VARIANT_128 = 128;
export const MF_VARIANT_3   = 3;

export function createMultiface({ core, memoryData, getMachineDef, romBytes, variant }) {
    const ram = new Uint8Array(RAM_SIZE);
    let paged = false;

    const slotBase = () => core.MACHINE_MEMORY + MULTIFACE_SLOT * 0x4000;

    function syncSlotToCache() {
        const base = slotBase();
        memoryData.set(romBytes.subarray(0, ROM_SIZE), base);
        memoryData.set(ram, base + ROM_SIZE);
    }
    function syncCacheFromSlot() {
        const base = slotBase();
        ram.set(memoryData.subarray(base + ROM_SIZE, base + ROM_SIZE + RAM_SIZE));
    }

    function pageIn() {
        if (paged) return;
        syncSlotToCache();
        memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = MULTIFACE_SLOT;
        memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = MULTIFACE_SLOT;
        paged = true;
        if (core.multifaceForcePage) core.multifaceForcePage(true);
    }
    function pageOut() {
        if (!paged) return;
        syncCacheFromSlot();
        const def = getMachineDef();
        if (def) {
            memoryData[core.MEMORY_PAGE_READ_MAP  + 0] = def.resetState.readMap[0];
            memoryData[core.MEMORY_PAGE_WRITE_MAP + 0] = def.resetState.writeMap[0];
        }
        paged = false;
        if (core.multifaceForcePage) core.multifaceForcePage(false);
    }

    /* Port read: A7 (bit 7) decides page in vs page out. MF3 inverts. */
    const handleRead = (port) => {
        const a7 = port & 0x0080;
        if (variant === MF_VARIANT_3) {
            if (a7) pageOut(); else pageIn();
        } else {
            if (a7) pageIn(); else pageOut();
        }
        return 0xff;
    };
    const handleWrite = () => {
        // Writes don't trigger paging on real HW (out is "lockout" semantics).
    };

    const portMask = 0x0072;
    const portMatch = (variant === MF_VARIANT_1) ? 0x0012 : 0x0032;

    return {
        type: 'multiface',
        variant,
        ports: [
            { mask: portMask, match: portMatch, read: handleRead, write: handleWrite },
        ],
        /* Press red button — request NMI. CPU services on next M1; wasm
           multiface-enabled flag causes the page-in at PC=0x0066. */
        pressButton() {
            if (core.setNmiRequested) core.setNmiRequested(1);
        },
        isPaged: () => paged,
        pageOut,
        reset() {
            ram.fill(0);
            paged = false;
            syncSlotToCache();
            // Wasm-side enable: tell core our slot and that we're attached.
            if (core.setMultiface) core.setMultiface(1, MULTIFACE_SLOT);
        },
        detach() {
            pageOut();
            if (core.setMultiface) core.setMultiface(0, 0);
        },
    };
}
