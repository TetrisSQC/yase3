import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile } from './tape.js';
import { PeriphBus } from './peripherals/index.js';
import { getMachine, hasMachine } from './machines/index.js';
import { selectMachine } from './machines/machineSelect.js';
import { parseTrd, writeTrd } from './disk/trd.js';
import { parseDsk } from './disk/dsk.js';
import { parseMgt, writeMgt } from './disk/mgt.js';
import { createPlusD } from './disk/plusd.js';
import { createDISCiPLE } from './disk/disciple.js';
import { createDidaktik } from './disk/didaktik.js';
import { parseDck } from './disk/dck.js';
import { createMultiface, MF_VARIANT_1, MF_VARIANT_128, MF_VARIANT_3 } from './peripherals/multiface.js';
import { createInterface1 } from './peripherals/interface1.js';
import { parseMdr, writeMdr } from './disk/mdr.js';

let core = null;
let memory = null;
let memoryData = null;
let workerFrameData = null;
let registerPairs = null;
let tapePulses = null;

let stopped = false;
let tape = null;
let tapeIsPlaying = false;

const periphBus = new PeriphBus();
let coreBaseUrl = null;
const romCache = new Map();

const loadCore = (baseUrl) => {
    coreBaseUrl = baseUrl;
    // Provide hostPortRead / hostPortWrite imports that bridge the wasm core
    // to the JS peripheral bus. PeriphBus.readPort returns null when no
    // peripheral claims the port; the wasm side falls back to 0xff floating.
    const imports = {
        core: {
            hostPortRead: (port) => {
                const v = periphBus.readPort(port, 0);
                // -1 → wasm falls through to kempston/floating-bus defaults.
                return v === null ? -1 : v & 0xff;
            },
            hostPortWrite: (port, val) => {
                periphBus.writePort(port, val & 0xff, 0);
            },
        },
    };
    WebAssembly.instantiateStreaming(
        fetch(new URL('jsspeccy-core.wasm', baseUrl), {}),
        imports
    ).then(results => {
        core = results.instance.exports;
        memory = core.memory;
        memoryData = new Uint8Array(memory.buffer);
        workerFrameData = memoryData.subarray(core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
        registerPairs = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
        tapePulses = new Uint16Array(core.memory.buffer, core.TAPE_PULSES, core.TAPE_PULSES_LENGTH);

        postMessage({
            'message': 'ready',
        });
    });
}

const loadMemoryPage = (page, data) => {
    memoryData.set(data, core.MACHINE_MEMORY + page * 0x4000);
};

/**
 * Fetch and cache a ROM file from static/roms/.
 * @returns {Promise<Uint8Array>}
 */
const fetchRom = async (filename) => {
    if (romCache.has(filename)) return romCache.get(filename);
    const url = new URL(`roms/${filename}`, coreBaseUrl);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetchRom: ${filename} → ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    romCache.set(filename, data);
    return data;
};

/**
 * Set the active machine, fetching its ROMs as needed.
 *
 * For machines whose tapeloader snapshot bundles all ROM pages (the original
 * 48/128/Pentagon path), we still pre-load ROMs so that a bare reset (no
 * snapshot) lands in a usable state. ROMs are tiny so cache hits dominate.
 */
let currentMachineId = null;

const applyMachine = async (id) => {
    if (!hasMachine(id)) {
        throw new Error(`applyMachine: unknown machine id ${id}`);
    }
    const def = getMachine(id);
    const roms = new Map();
    for (const slot of def.romPages) {
        roms.set(slot.file, await fetchRom(slot.file));
    }
    selectMachine(core, memoryData, periphBus, id, roms);
    currentMachineId = id;
    if (tape && typeof tape.setMachineType === 'function') {
        tape.setMachineType(id);
    }
    // Re-apply IF2 override after machine switch (selectMachine reloaded ROM
    // slots / read maps to stock).
    applyInterface2();
    // selectMachine wiped the periph bus; re-attach dynamic peripherals.
    plusdInstance = null;
    discipleInstance = null;
    if (plusdEnabled) {
        if (!romCache.has('plusd.rom')) await fetchRom('plusd.rom');
        attachPlusD();
    }
    if (discipleEnabled) {
        if (!romCache.has('disciple.rom')) await fetchRom('disciple.rom');
        attachDISCiPLE();
    }
    didaktikInstance = null;
    if (didaktikEnabled) {
        try {
            if (!romCache.has('didaktik80.rom')) await fetchRom('didaktik80.rom');
            attachDidaktik();
        } catch (err) {
            console.error('Didaktik ROM missing:', err);
            didaktikEnabled = false;
        }
    }
    if1Instance = null;
    if (if1Enabled) {
        try {
            if (!romCache.has('if1-2.rom')) await fetchRom('if1-2.rom');
            attachInterface1();
        } catch (err) {
            console.error('IF1 ROM missing:', err);
            if1Enabled = false;
        }
    }
    multifaceInstance = null;
    if (multifaceEnabled) {
        const variant = multifaceVariantFor(currentMachineId);
        const romFile = multifaceRomFor(variant);
        try {
            if (!romCache.has(romFile)) await fetchRom(romFile);
            attachMultiface();
        } catch (err) {
            console.error('Multiface ROM missing:', err);
            multifaceEnabled = false;
        }
    }
    // Restore Timex dock cart bytes after selectMachine re-built the slot.
    applyTimexDock();
};

function findPeripheral(type) {
    return periphBus.active.find((p) => p.type === type) || null;
}

/* Serialise the wasm core state for the debugger overlay and send it
   back to the host. Memory window is 256 bytes starting 32 below PC so
   the disasm + memory pane has enough context. */
/* Collect everything needed to serialise the current emulator state into
   a .z80 file. We send copies (Transferable Uint8Array buffers) so the
   host can build the file without further worker round-trips. */
function sendExportSnapshot(queryId) {
    if (!core) return;
    const def = currentMachineId === null ? null : getMachine(currentMachineId);
    const is48 = currentMachineId === 48;
    const regs = new Uint16Array(12);
    regs.set(new Uint16Array(core.memory.buffer, core.REGISTERS, 12));

    // Last byte written to 7ffd port. wasm core exposes lastMemoryPort via
    // no direct getter — but we can read it indirectly via the current
    // memoryPageReadMap[3] (RAM page bits 0..2) + screenPageIndex (bit 3).
    // For 48K just send 0. For 128K reconstruct minimal pagingFlags.
    let pagingFlags = 0;
    if (!is48) {
        // page bits 0-2 from slot 3
        const slot3 = (new Uint8Array(core.memory.buffer, core.MEMORY_PAGE_READ_MAP, 4))[3];
        pagingFlags |= slot3 & 0x07;
        // screen bit 3: not directly observable; we leave 0 (page 5 default).
        // ROM bit 4: rom1 → 1, rom0 → 0
        const slot0 = (new Uint8Array(core.memory.buffer, core.MEMORY_PAGE_READ_MAP, 4))[0];
        const rom0 = def?.romPages[0]?.wasmPage ?? 0;
        const rom1 = def?.romPages[1]?.wasmPage ?? rom0;
        if (slot0 === rom1) pagingFlags |= 0x10;
    }

    // Dump RAM pages. 48K: pages 0/2/5. 128K: pages 0-7.
    const pageNums = is48 ? [0, 2, 5] : [0, 1, 2, 3, 4, 5, 6, 7];
    const pages = new Map();
    for (const n of pageNums) {
        const slice = new Uint8Array(0x4000);
        slice.set(memoryData.subarray(
            core.MACHINE_MEMORY + n * 0x4000,
            core.MACHINE_MEMORY + (n + 1) * 0x4000));
        pages.set(n, slice);
    }

    // Border colour: only the low 3 bits matter, captured from the most
    // recent ULA write. The wasm core stores it but has no getter; the
    // best we can do without adding one is read it via peek of the
    // value-tracking side channel — for now we encode 0.
    const borderColour = 0;

    postMessage({
        message: 'exportSnapshotData',
        queryId,
        regs: regs.buffer,
        pc: core.getPC(),
        iff1: core.getIFF1() ? 1 : 0,
        iff2: core.getIFF2() ? 1 : 0,
        im: core.getIM(),
        tstates: core.getTStates(),
        halted: core.getHalted() ? 1 : 0,
        machineModel: currentMachineId,
        pagingFlags,
        borderColour,
        pages: Array.from(pages.entries()).map(([n, b]) => ({ num: n, bytes: b.buffer })),
    }, [regs.buffer, ...Array.from(pages.values()).map((b) => b.buffer)]);
}

/* Pokefinder — cheat-search candidate tracking. Scans 64 K of address
   space, filters surviving addresses against the previous-snapshot value
   using one of the standard modes ("less than", "greater than", "equal",
   "specific value"). State persists across calls until reset. */
const pokefinder = {
    active: false,
    candidates: null,    // Uint8Array(0x10000) — 1 if still a candidate
    lastValues: null,    // Uint8Array(0x10000) — value at last narrowing
    count: 0,
};

function dumpAllMemory() {
    const out = new Uint8Array(0x10000);
    for (let a = 0; a < 0x10000; a++) out[a] = core.peek(a);
    return out;
}

function pokefinderReset() {
    pokefinder.candidates = new Uint8Array(0x10000);
    pokefinder.candidates.fill(1);
    pokefinder.lastValues = dumpAllMemory();
    pokefinder.count = 0x10000;
    pokefinder.active = true;
}

function pokefinderNarrow(mode, value) {
    if (!pokefinder.active) pokefinderReset();
    const now = dumpAllMemory();
    const cands = pokefinder.candidates;
    const last = pokefinder.lastValues;
    let kept = 0;
    for (let a = 0; a < 0x10000; a++) {
        if (!cands[a]) continue;
        const cur = now[a];
        const prev = last[a];
        let pass = false;
        switch (mode) {
            case 'less':    pass = cur <  prev; break;
            case 'greater': pass = cur >  prev; break;
            case 'equal':   pass = cur === prev; break;
            case 'notEqual':pass = cur !== prev; break;
            case 'value':   pass = cur === (value & 0xff); break;
            default:        pass = true;
        }
        if (pass) {
            kept++;
            last[a] = cur;
        } else {
            cands[a] = 0;
        }
    }
    pokefinder.count = kept;
}

function pokefinderSamples(limit) {
    if (!pokefinder.active) return [];
    const out = [];
    const cands = pokefinder.candidates;
    for (let a = 0; a < 0x10000 && out.length < limit; a++) {
        if (cands[a]) out.push({ addr: a, value: core.peek(a) });
    }
    return out;
}

function sendDebugSnapshot() {
    if (!core) return;
    const pc = core.getPC();
    const memBase = (pc - 32) & 0xffff;
    const mem = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mem[i] = core.peek((memBase + i) & 0xffff);
    // Copy register pairs + breakpoint flags for the memory window.
    const regs = new Uint16Array(12);
    regs.set(new Uint16Array(core.memory.buffer, core.REGISTERS, 12));
    const bpFlags = new Uint8Array(256);
    const bpAll = new Uint8Array(core.memory.buffer, core.BREAKPOINTS, 0x10000);
    for (let i = 0; i < 256; i++) bpFlags[i] = bpAll[(memBase + i) & 0xffff];
    postMessage({
        message: 'debugSnapshot',
        regs: regs.buffer,
        mem: mem.buffer,
        bpFlags: bpFlags.buffer,
        memBase,
        pc,
        iff1: core.getIFF1() ? 1 : 0,
        iff2: core.getIFF2() ? 1 : 0,
        im: core.getIM(),
        tstates: core.getTStates(),
        halted: core.getHalted() ? 1 : 0,
    }, [regs.buffer, mem.buffer, bpFlags.buffer]);
}

/* Interface 2 ROM cartridge state.
   IF2 supplies a 16K ROM that overlays ROM bank 0. Stored byte cache so
   we can re-apply the override on machine switch and reset. */
const IF2_SLOT = 78;          // 16 K cartridge ROM
// +D / DISCiPLE / Timex Dock claim slots 80+; see disk/plusd.js for PLUSD_SLOT.
let interface2Cart = null;

/* Timex Dock cartridge state.
   We store the bottom 16 K (chunks 0+1) of the DOCK bank of the loaded .dck
   and overlay it onto wasm slot 82 (dockBlankPage). When SCLD HSR routes a
   16 K bank to DOCK, wasm reads cart bytes instead of the 0xff blank.
   Multi-block / multi-bank carts are flattened to chunks 0+1 only — enough
   for AROS-style cartridges that BIOS sniffs at boot. */
const DOCK_SLOT = 82;
let timexDockCart = null;     // Uint8Array(16384) or null

function applyTimexDock() {
    if (!core) return;
    const base = core.MACHINE_MEMORY + DOCK_SLOT * 0x4000;
    if (timexDockCart) {
        memoryData.set(timexDockCart, base);
    } else {
        memoryData.fill(0xff, base, base + 0x4000);
    }
}

/* +D peripheral state. The +D is a user-attachable peripheral, not part
   of any machine def. When enabled we instantiate it after each
   selectMachine() and append to the bus. */
let plusdEnabled = false;
let plusdInstance = null;

function attachPlusD() {
    if (!plusdEnabled || !core || currentMachineId === null) return;
    const romBytes = romCache.get('plusd.rom');
    if (!romBytes) return;  // ROM not fetched yet
    plusdInstance = createPlusD({
        core,
        memoryData,
        getMachineDef: () => getMachine(currentMachineId),
        romBytes,
    });
    plusdInstance.reset();
    periphBus.active.push(plusdInstance);
    core.setHostPortsEnabled(1);
}

function detachPlusD() {
    if (plusdInstance) {
        plusdInstance.pageOut();
        const idx = periphBus.active.indexOf(plusdInstance);
        if (idx >= 0) periphBus.active.splice(idx, 1);
        plusdInstance = null;
    }
    syncHostPortsEnabled();
}

/* DISCiPLE peripheral — same architecture as +D. */
let discipleEnabled = false;
let discipleInstance = null;

function attachDISCiPLE() {
    if (!discipleEnabled || !core || currentMachineId === null) return;
    const romBytes = romCache.get('disciple.rom');
    if (!romBytes) return;
    discipleInstance = createDISCiPLE({
        core,
        memoryData,
        getMachineDef: () => getMachine(currentMachineId),
        romBytes,
    });
    discipleInstance.reset();
    periphBus.active.push(discipleInstance);
    core.setHostPortsEnabled(1);
}

function detachDISCiPLE() {
    if (discipleInstance) {
        discipleInstance.pageOut();
        const idx = periphBus.active.indexOf(discipleInstance);
        if (idx >= 0) periphBus.active.splice(idx, 1);
        discipleInstance = null;
    }
    syncHostPortsEnabled();
}

/* Interface 1 + Microdrive. ROM file: if1-2.rom (8 KB). Not redistributable. */
let if1Enabled = false;
let if1Instance = null;
const pendingMdrInserts = [];      // {drive, mdr} queued before attach

function attachInterface1() {
    if (!if1Enabled || !core || currentMachineId === null) return;
    const romBytes = romCache.get('if1-2.rom');
    if (!romBytes) return;
    if1Instance = createInterface1({ core, memoryData, romBytes });
    if1Instance.reset();
    periphBus.active.push(if1Instance);
    core.setHostPortsEnabled(1);
    for (const { drive, mdr } of pendingMdrInserts) if1Instance.insertMicrodrive(drive, mdr);
    pendingMdrInserts.length = 0;
}
function detachInterface1() {
    if (if1Instance) {
        if1Instance.detach();
        const idx = periphBus.active.indexOf(if1Instance);
        if (idx >= 0) periphBus.active.splice(idx, 1);
        if1Instance = null;
    }
    syncHostPortsEnabled();
}

/* Multiface (One / 128 / 3). Variant auto-picked from current machine. */
let multifaceEnabled = false;
let multifaceInstance = null;

function multifaceVariantFor(machineId) {
    // 48K, TS2068, TC2068, SE → MF One
    if (machineId === 48 || machineId === 13 || machineId === 17 || machineId === 15) return MF_VARIANT_1;
    // +2A / +3 / +3e → MF 3
    if (machineId === 7 || machineId === 8 || machineId === 12) return MF_VARIANT_3;
    // Everything else (128, Pentagon, Scorpion) → MF 128
    return MF_VARIANT_128;
}
function multifaceRomFor(variant) {
    if (variant === MF_VARIANT_1)   return 'mf1.rom';
    if (variant === MF_VARIANT_128) return 'mf128.rom';
    return 'mf3.rom';
}

function attachMultiface() {
    if (!multifaceEnabled || !core || currentMachineId === null) return;
    const variant = multifaceVariantFor(currentMachineId);
    const romFile = multifaceRomFor(variant);
    const romBytes = romCache.get(romFile);
    if (!romBytes) return;
    multifaceInstance = createMultiface({
        core, memoryData,
        getMachineDef: () => getMachine(currentMachineId),
        romBytes, variant,
    });
    multifaceInstance.reset();
    periphBus.active.push(multifaceInstance);
    core.setHostPortsEnabled(1);
}

function detachMultiface() {
    if (multifaceInstance) {
        multifaceInstance.detach();
        const idx = periphBus.active.indexOf(multifaceInstance);
        if (idx >= 0) periphBus.active.splice(idx, 1);
        multifaceInstance = null;
    }
    syncHostPortsEnabled();
}

/* Didaktik D80 peripheral. */
let didaktikEnabled = false;
let didaktikInstance = null;

function attachDidaktik() {
    if (!didaktikEnabled || !core || currentMachineId === null) return;
    const romBytes = romCache.get('didaktik80.rom');
    if (!romBytes) return;
    didaktikInstance = createDidaktik({
        core,
        memoryData,
        getMachineDef: () => getMachine(currentMachineId),
        romBytes,
    });
    didaktikInstance.reset();
    periphBus.active.push(didaktikInstance);
    core.setHostPortsEnabled(1);
}

function detachDidaktik() {
    if (didaktikInstance) {
        didaktikInstance.pageOut();
        const idx = periphBus.active.indexOf(didaktikInstance);
        if (idx >= 0) periphBus.active.splice(idx, 1);
        didaktikInstance = null;
    }
    syncHostPortsEnabled();
}

function syncHostPortsEnabled() {
    if (!core || currentMachineId === null) return;
    const def = getMachine(currentMachineId);
    const HOST = new Set(['upd765','wd1770','beta128','plusd','disciple','opus','didaktik','multiface','interface1']);
    const stockNeeds = def?.periph?.some((p) => HOST.has(p.type)) ?? false;
    const dynNeeds = !!plusdInstance || !!discipleInstance || !!didaktikInstance || !!multifaceInstance || !!if1Instance;
    core.setHostPortsEnabled(stockNeeds || dynNeeds ? 1 : 0);
}

function applyInterface2() {
    if (!interface2Cart || !core) return;
    memoryData.set(interface2Cart, core.MACHINE_MEMORY + IF2_SLOT * 0x4000);
    memoryData[core.MEMORY_PAGE_READ_MAP + 0] = IF2_SLOT;
    memoryData[core.RESET_READ_MAP + 0] = IF2_SLOT;
}

function clearInterface2() {
    interface2Cart = null;
    if (!core || currentMachineId === null) return;
    const def = getMachine(currentMachineId);
    if (!def) return;
    memoryData[core.MEMORY_PAGE_READ_MAP + 0] = def.resetState.readMap[0];
    memoryData[core.RESET_READ_MAP + 0] = def.resetState.readMap[0];
}

function controllerTypeFor(controller) {
    // Maps the menu-tree controller key to the peripheral 'type' string.
    switch (controller) {
        case 'beta':     return 'beta128';
        case 'plus3':    return 'upd765';
        case 'plusd':    return 'plusd';
        case 'disciple': return 'disciple';
        case 'opus':     return 'opus';
        case 'didaktik': return 'didaktik';
    }
    return null;
}

function parseDiskByKind(kind, data) {
    if (kind === 'trd') return parseTrd(data.buffer ?? data);
    if (kind === 'dsk') return parseDsk(data.buffer ?? data);
    // .mgt/.img/.d80 all share the same geometry (80 cyl × 2 head × 10 sec × 512 B).
    if (kind === 'mgt' || kind === 'img' || kind === 'd80' || kind === 'd40')
        return parseMgt(data.buffer ?? data);
    throw new Error(`Unknown disk kind: ${kind}`);
}

function insertDisk(controller, drive, kind, data) {
    const type = controllerTypeFor(controller);
    if (!type) {
        console.warn(`insertDisk: unknown controller '${controller}'`);
        return;
    }
    const periph = findPeripheral(type);
    if (!periph || !periph.insert) {
        console.warn(`insertDisk: peripheral '${type}' not active on current machine`);
        return;
    }
    const disk = parseDiskByKind(kind, data);
    periph.insert(drive, disk);
}

function tapeBlockInfo(block, index, currentIndex) {
    // TAP blocks are raw Uint8Arrays; TZX blocks are objects with a 'type' field.
    const isCurrent = index === currentIndex;
    if (block instanceof Uint8Array) {
        if (block[0] === 0x00 && block.length >= 18) {
            const fileTypes = ['Program', 'Num Array', 'Char Array', 'Code'];
            const fileType = block[1] < 4 ? fileTypes[block[1]] : 'Unknown';
            const name = String.fromCharCode(...block.slice(2, 12)).replace(/\s+$/, '');
            return { index, kind: 'Header', detail: `${fileType}: "${name}"`, length: block.length, current: isCurrent };
        }
        return { index, kind: 'Data', detail: `${block.length} bytes`, length: block.length, current: isCurrent };
    }
    // TZX object block
    const dataBlocks = new Set(['StandardSpeedData', 'TurboSpeedData', 'GeneralData', 'DirectRecording']);
    if (dataBlocks.has(block.type) && block.data && block.data.length > 0) {
        const d = block.data;
        if (d[0] === 0x00 && d.length >= 18) {
            const fileTypes = ['Program', 'Num Array', 'Char Array', 'Code'];
            const fileType = d[1] < 4 ? fileTypes[d[1]] : 'Unknown';
            const name = String.fromCharCode(...d.slice(2, 12)).replace(/\s+$/, '');
            return { index, kind: 'Header', detail: `${fileType}: "${name}"`, length: d.length, current: isCurrent };
        }
        return { index, kind: 'Data', detail: `${block.type} ${d.length}b`, length: d.length, current: isCurrent };
    }
    return { index, kind: block.type || 'Control', detail: block.type || '', length: 0, current: isCurrent };
}

function ejectDisk(controller, drive) {
    const type = controllerTypeFor(controller);
    if (!type) return;
    const periph = findPeripheral(type);
    if (periph?.eject) periph.eject(drive);
}

function saveDiskBytes(controller, drive) {
    const type = controllerTypeFor(controller);
    if (!type) return null;
    const periph = findPeripheral(type);
    const disk = periph?.fdc?.drives?.[drive]?.disk;
    if (!disk) return null;
    // Pick format by controller: beta = trd, plusd/disciple/didaktik = mgt.
    if (controller === 'beta') return writeTrd(disk);
    return writeMgt(disk);
}

function toggleDiskFlip(controller, drive) {
    const type = controllerTypeFor(controller);
    if (!type) return;
    const periph = findPeripheral(type);
    const d = periph?.fdc?.drives?.[drive];
    if (!d) return;
    d.flipped = !d.flipped;
}
function toggleDiskWP(controller, drive) {
    const type = controllerTypeFor(controller);
    if (!type) return;
    const periph = findPeripheral(type);
    const disk = periph?.fdc?.drives?.[drive]?.disk;
    if (!disk) return;
    disk.writeProtect = !disk.writeProtect;
}

const loadSnapshot = async (snapshot) => {
    // Switch to the snapshot's target machine first so ROMs for that model
    // are fetched into their wasm slots. Tape-loader snapshots bundle their
    // ROM pages but generic snapshots (Z80 / SNA / SZX from search) carry
    // only RAM — without this the CPU jumps into an empty ROM slot and
    // executes garbage. applyMachine awaits the ROM fetch.
    if (snapshot.model !== currentMachineId) {
        await applyMachine(snapshot.model);
    } else {
        selectMachine(core, memoryData, periphBus, snapshot.model, null);
    }
    for (let page in snapshot.memoryPages) {
        loadMemoryPage(page, snapshot.memoryPages[page]);
    }
    ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach(
        (r, i) => {
            registerPairs[i] = snapshot.registers[r];
        }
    )
    core.setPC(snapshot.registers.PC);
    core.setIFF1(snapshot.registers.iff1);
    core.setIFF2(snapshot.registers.iff2);
    core.setIM(snapshot.registers.im);
    core.setHalted(!!snapshot.halted);

    core.writePort(0x00fe, snapshot.ulaState.borderColour);
    if (snapshot.model != 48) {
        core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
    }

    core.setTStates(snapshot.tstates);
};

/* Step-over: one-shot breakpoint state. When a debugStepOver issues a
   CALL/RST trap we remember the previous bitmap value so the bp is
   cleared cleanly on hit. */
let stepOverAddr = -1;
let stepOverPrevBp = 0;

/* RZX state — per-frame record/playback management. */
const rzxRecord   = { active: false, frames: [] };
const rzxPlayback = { active: false, frames: [], frameIndex: 0 };

/* Tape recording state — captured save blocks pending bundling into a
   .tap file. Each block is a Uint8Array of {flag, ...data, parity}. */
let recordedTapeBlocks = [];

/* SA-BYTES trap: A = flag, IX = start, DE = length, carry = save vs verify.
   We emit a TAP-format block (flag + data + parity) and exit at 0x053e
   (the RET inside SA-BYTES). */
function trapTapeSave() {
    const af = registerPairs[0];        // AF
    const a  = (af >> 8) & 0xff;
    const ix = registerPairs[8];        // IX
    const de = registerPairs[2];        // DE

    const block = new Uint8Array(de + 2);
    block[0] = a;
    let parity = a;
    for (let i = 0; i < de; i++) {
        const b = core.peek((ix + i) & 0xffff);
        block[1 + i] = b;
        parity ^= b;
    }
    block[de + 1] = parity & 0xff;
    recordedTapeBlocks.push(block);

    // Set carry to indicate success, jump to SA-BYTES exit (the RET at 0x053e
    // pops the caller-supplied return address).
    registerPairs[0] |= 0x0001;
    core.setPC(0x053e);
}

const trapTapeLoad = () => {
    if (!tape) return;
    const block = tape.getNextLoadableBlock();
    if (!block) return;

    /* get expected block type and load vs verify flag from AF' */
    const af_ = registerPairs[4];
    const expectedBlockType = af_ >> 8;
    const shouldLoad = af_ & 0x0001;  // LOAD rather than VERIFY
    let addr = registerPairs[8];  /* IX */
    const requestedLength = registerPairs[2];  /* DE */
    const actualBlockType = block[0];

    let success = true;
    if (expectedBlockType != actualBlockType) {
        success = false;
    } else {
        if (shouldLoad) {
            let offset = 1;
            let loadedBytes = 0;
            let checksum = actualBlockType;
            while (loadedBytes < requestedLength) {
                if (offset >= block.length) {
                    /* have run out of bytes to load */
                    success = false;
                    break;
                }
                const byte = block[offset++];
                loadedBytes++;
                core.poke(addr, byte);
                addr = (addr + 1) & 0xffff;
                checksum ^= byte;
            }

            // if loading is going right, we should still have a checksum byte left to read
            success &= (offset < block.length);
            if (success) {
                const expectedChecksum = block[offset];
                success = (checksum === expectedChecksum);
            }
        } else {
            // VERIFY. TODO: actually verify.
            success = true;
        }
    }

    if (success) {
        /* set carry to indicate success */
        registerPairs[0] |= 0x0001;
    } else {
        /* reset carry to indicate failure */
        registerPairs[0] &= 0xfffe;
    }
    core.setPC(0x05e2);  /* address at which to exit the tape trap */
}

onmessage = (e) => {
    switch (e.data.message) {
        case 'loadCore':
            loadCore(e.data.baseUrl);
            break;
        case 'runFrame':
            if (stopped) return;
            const frameBuffer = e.data.frameBuffer;
            const frameData = new Uint8Array(frameBuffer);

            let audioBufferLeft = null;
            let audioBufferRight = null;
            let audioLength = 0;
            if ('audioBufferLeft' in e.data) {
                audioBufferLeft = e.data.audioBufferLeft;
                audioBufferRight = e.data.audioBufferRight;
                audioLength = audioBufferLeft.byteLength / 4;
                core.setAudioSamplesPerFrame(audioLength);
            } else {
                core.setAudioSamplesPerFrame(0);
            }

            if (tape && tapeIsPlaying) {
                const tapePulseBufferTstateCount = core.getTapePulseBufferTstateCount();
                const tapePulseWriteIndex = core.getTapePulseWriteIndex();
                const [newTapePulseWriteIndex, tstatesGenerated, tapeFinished] = tape.pulseGenerator.emitPulses(
                    tapePulses, tapePulseWriteIndex, 80000 - tapePulseBufferTstateCount
                );
                core.setTapePulseBufferState(newTapePulseWriteIndex, tapePulseBufferTstateCount + tstatesGenerated);
                if (tapeFinished) {
                    tapeIsPlaying = false;
                    postMessage({
                        message: 'stoppedTape',
                    });
                }
            }

            // RZX playback: feed this frame's recorded input bytes into wasm.
            if (rzxPlayback.active) {
                const f = rzxPlayback.frames[rzxPlayback.frameIndex];
                if (!f) {
                    // End of recording — stop playback automatically.
                    rzxPlayback.active = false;
                    core.setRzxMode(0);
                    core.rzxResetFrame();
                    postMessage({ message: 'rzxStateChanged', mode: 'idle' });
                } else {
                    const buf = new Uint8Array(core.memory.buffer, core.RZX_BUFFER, 8192);
                    buf.set(f.inputs.subarray(0, Math.min(f.inputs.length, 8192)));
                    core.setRzxReplay(f.inputs.length);
                    rzxPlayback.frameIndex++;
                }
            } else if (rzxRecord.active) {
                core.rzxResetFrame();
            }

            let status = core.runFrame();
            let hitBreakpoint = false;
            while (status) {
                switch (status) {
                    case 1:
                        stopped = true;
                        throw("Unrecognised opcode!");
                    case 2:
                        trapTapeLoad();
                        break;
                    case 3:
                        // Breakpoint — bail out of the frame, notify host.
                        hitBreakpoint = true;
                        break;
                    case 4:
                        trapTapeSave();
                        break;
                    default:
                        stopped = true;
                        throw("runFrame returned unexpected result: " + status);
                }
                if (hitBreakpoint) break;
                status = core.resumeFrame();
            }
            if (hitBreakpoint) {
                const hitPC = core.getPC();
                if (stepOverAddr === hitPC) {
                    // Auto-clear the one-shot step-over breakpoint.
                    const bp = new Uint8Array(core.memory.buffer, core.BREAKPOINTS, 0x10000);
                    bp[hitPC] = stepOverPrevBp;
                    stepOverAddr = -1;
                    let any = false;
                    for (let i = 0; i < 0x10000; i++) if (bp[i]) { any = true; break; }
                    core.setBreakpointsArmed(any ? 1 : 0);
                }
                postMessage({ message: 'breakpointHit', pc: hitPC });
            }

            // RZX recording: stash this frame's input bytes + fetch count.
            if (rzxRecord.active) {
                const count = core.getRzxIndex();
                const src = new Uint8Array(core.memory.buffer, core.RZX_BUFFER, count);
                const inputs = new Uint8Array(count);
                inputs.set(src);
                rzxRecord.frames.push({ fetches: core.getRzxFrameFetches(), inputs });
            }

            frameData.set(workerFrameData);
            if (audioLength) {
                const leftSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength);
                const rightSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength);
                const leftData = new Float32Array(audioBufferLeft);
                const rightData = new Float32Array(audioBufferRight);
                leftData.set(leftSource);
                rightData.set(rightSource);
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                    audioBufferLeft,
                    audioBufferRight,
                }, [frameBuffer, audioBufferLeft, audioBufferRight]);
            } else {
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                }, [frameBuffer]);
            }

            break;
        case 'keyDown':
            core.keyDown(e.data.row, e.data.mask);
            break;
        case 'keyUp':
            core.keyUp(e.data.row, e.data.mask);
            break;
        case 'setKempstonState':
            if (core && core.setKempstonState) core.setKempstonState(e.data.state & 0xff);
            break;
        case 'setMachineType':
            applyMachine(e.data.type).catch((err) => {
                console.error('setMachineType failed:', err);
            });
            break;
        case 'reset':
            core.reset();
            periphBus.reset();
            break;
        case 'hardReset':
            applyMachine(currentMachineId).then(() => {
                core.reset();
                periphBus.reset();
            }).catch((err) => {
                console.error('hardReset failed:', err);
            });
            break;
        case 'nmi':
            if (core.setNmiRequested) core.setNmiRequested(1);
            break;
        case 'debugStep':
            if (core.step) {
                const status = core.step();
                if (status === 2) trapTapeLoad();
            }
            sendDebugSnapshot();
            break;
        case 'debugStepOver': {
            const pc = core.getPC();
            const op = core.peek(pc);
            const isCall = (op === 0xcd) || ((op & 0xc7) === 0xc4);
            const isRst  = ((op & 0xc7) === 0xc7);
            // Skip CALL / RST by setting a one-shot breakpoint after them.
            if (isCall || isRst) {
                const nextPC = (pc + (isCall ? 3 : 1)) & 0xffff;
                const bp = new Uint8Array(core.memory.buffer, core.BREAKPOINTS, 0x10000);
                stepOverPrevBp = bp[nextPC];
                stepOverAddr = nextPC;
                bp[nextPC] = 1;
                core.setBreakpointsArmed(1);
                postMessage({ message: 'stepOverArmed' });
            } else if (core.step) {
                const status = core.step();
                if (status === 2) trapTapeLoad();
                sendDebugSnapshot();
            }
            break;
        }
        case 'debugSnapshot':
            sendDebugSnapshot();
            break;
        case 'exportSnapshot':
            sendExportSnapshot(e.data.queryId);
            break;
        case 'debugSetBreakpoint': {
            // e.data: { addr (0..65535), on (bool) }
            const bp = new Uint8Array(core.memory.buffer, core.BREAKPOINTS, 0x10000);
            bp[e.data.addr & 0xffff] = e.data.on ? 1 : 0;
            // Re-arm: scan once for any active bp.
            let any = false;
            for (let i = 0; i < 0x10000; i++) if (bp[i]) { any = true; break; }
            core.setBreakpointsArmed(any ? 1 : 0);
            postMessage({ message: 'breakpointsChanged', armed: any });
            break;
        }
        case 'debugClearBreakpoints': {
            const bp = new Uint8Array(core.memory.buffer, core.BREAKPOINTS, 0x10000);
            bp.fill(0);
            core.setBreakpointsArmed(0);
            postMessage({ message: 'breakpointsChanged', armed: false });
            break;
        }
        case 'debugPoke':
            if (core) core.poke(e.data.addr & 0xffff, e.data.val & 0xff);
            sendDebugSnapshot();
            break;
        case 'rzxStartRecord':
            rzxRecord.active = true;
            rzxRecord.frames = [];
            core.setRzxMode(1);
            core.rzxResetFrame();
            postMessage({ message: 'rzxStateChanged', mode: 'record' });
            break;
        case 'rzxStopRecord':
            rzxRecord.active = false;
            core.setRzxMode(0);
            core.rzxResetFrame();
            postMessage({ message: 'rzxStateChanged', mode: 'idle' });
            break;
        case 'rzxBeginPlayback':
            // e.data: { frames: [{fetches, inputs}], snapshotZ80 }
            rzxPlayback.active = true;
            rzxPlayback.frames = e.data.frames.map((f) => ({ fetches: f.fetches, inputs: new Uint8Array(f.inputs) }));
            rzxPlayback.frameIndex = 0;
            core.setRzxMode(2);
            core.rzxResetFrame();
            postMessage({ message: 'rzxStateChanged', mode: 'playback' });
            break;
        case 'rzxStopPlayback':
            rzxPlayback.active = false;
            core.setRzxMode(0);
            core.rzxResetFrame();
            postMessage({ message: 'rzxStateChanged', mode: 'idle' });
            break;
        case 'rzxGetRecording': {
            // Bundles recorded frames; host wraps into final RZX file.
            postMessage({
                message: 'rzxRecordingData',
                queryId: e.data.queryId,
                frames: rzxRecord.frames.map((f) => ({ fetches: f.fetches, inputs: f.inputs.buffer })),
            }, rzxRecord.frames.map((f) => f.inputs.buffer));
            // Buffers transferred — clear the worker-side cache so we don't reuse
            // detached storage on later replay.
            rzxRecord.frames = [];
            break;
        }
        case 'startTapeRecording':
            recordedTapeBlocks = [];
            if (core.setTapeRecording) core.setTapeRecording(1);
            postMessage({ message: 'tapeRecordingChanged', recording: true });
            break;
        case 'stopTapeRecording':
            if (core.setTapeRecording) core.setTapeRecording(0);
            postMessage({ message: 'tapeRecordingChanged', recording: false });
            break;
        case 'getRecordedTape': {
            // Bundle recordedTapeBlocks into a TAP file (each block prefixed
            // by little-endian 16-bit length).
            let total = 0;
            for (const b of recordedTapeBlocks) total += 2 + b.length;
            const buf = new Uint8Array(total);
            let off = 0;
            for (const b of recordedTapeBlocks) {
                buf[off++] = b.length & 0xff;
                buf[off++] = (b.length >> 8) & 0xff;
                buf.set(b, off);
                off += b.length;
            }
            postMessage({
                message: 'recordedTapeData',
                queryId: e.data.queryId,
                blocks: recordedTapeBlocks.length,
                data: buf.buffer,
            }, [buf.buffer]);
            break;
        }
        case 'pokefinderReset':
            pokefinderReset();
            postMessage({ message: 'pokefinderState', count: pokefinder.count, total: 0x10000 });
            break;
        case 'pokefinderNarrow':
            pokefinderNarrow(e.data.mode, e.data.value);
            postMessage({ message: 'pokefinderState', count: pokefinder.count, total: 0x10000 });
            break;
        case 'pokefinderSamples': {
            const samples = pokefinderSamples(e.data.limit | 0 || 32);
            postMessage({
                message: 'pokefinderSamplesData',
                queryId: e.data.queryId,
                samples,
                count: pokefinder.count,
            });
            break;
        }
        case 'debugReadMem': {
            // e.data: { queryId, base, length }
            const len = Math.min(e.data.length | 0, 0x10000);
            const out = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                out[i] = core.peek((e.data.base + i) & 0xffff);
            }
            postMessage({
                message: 'debugMemData',
                queryId: e.data.queryId,
                base: e.data.base & 0xffff,
                bytes: out.buffer,
            }, [out.buffer]);
            break;
        }
        case 'rewindTape':
            if (tape) {
                tape.nextBlockIndex = 0;
                if (tapeIsPlaying) {
                    tapeIsPlaying = false;
                    postMessage({ message: 'stoppedTape' });
                }
            }
            break;
        case 'seekTape':
            if (tape) {
                tape.nextBlockIndex = Math.max(0, Math.min(e.data.index, tape.blocks.length - 1));
                if (tapeIsPlaying) {
                    tapeIsPlaying = false;
                    postMessage({ message: 'stoppedTape' });
                }
            }
            break;
        case 'getTapeBlocks': {
            const blocks = tape
                ? tape.blocks.map((b, i) => tapeBlockInfo(b, i, tape.nextBlockIndex))
                : [];
            postMessage({ message: 'tapeBlocks', queryId: e.data.queryId, blocks });
            break;
        }
        case 'loadMemory':
            loadMemoryPage(e.data.page, e.data.data);
            break;
        case 'loadSnapshot':
            loadSnapshot(e.data.snapshot).then(() => {
                postMessage({
                    message: 'fileOpened',
                    id: e.data.id,
                    mediaType: 'snapshot',
                });
            }).catch((err) => {
                console.error('loadSnapshot failed:', err);
                postMessage({
                    message: 'fileOpened',
                    id: e.data.id,
                    mediaType: 'snapshot',
                });
            });
            break;
        case 'openTAPFile':
            tape = new TAPFile(e.data.data);
            tapeIsPlaying = false;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            break;
        case 'openTZXFile':
            tape = new TZXFile(e.data.data);
            if (currentMachineId != null && typeof tape.setMachineType === 'function') {
                tape.setMachineType(currentMachineId);
            }
            tapeIsPlaying = false;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            break;
        
        case 'playTape':
            if (tape && !tapeIsPlaying) {
                tapeIsPlaying = true;
                postMessage({
                    message: 'playingTape',
                });
            }
            break;
        case 'stopTape':
            if (tape && tapeIsPlaying) {
                tapeIsPlaying = false;
                postMessage({
                    message: 'stoppedTape',
                });
            }
            break;
        case 'setTapeTraps':
            core.setTapeTraps(e.data.value);
            break;
        case 'insertDisk':
            insertDisk(e.data.controller, e.data.drive, e.data.kind, e.data.data);
            break;
        case 'ejectDisk':
            ejectDisk(e.data.controller, e.data.drive);
            break;
        case 'saveDisk': {
            const bytes = saveDiskBytes(e.data.controller, e.data.drive);
            postMessage({
                message: 'savedDiskData',
                queryId: e.data.queryId,
                controller: e.data.controller,
                drive: e.data.drive,
                data: bytes ? bytes.buffer : null,
            }, bytes ? [bytes.buffer] : []);
            break;
        }
        case 'flipDisk':
            toggleDiskFlip(e.data.controller, e.data.drive);
            break;
        case 'wpDisk':
            toggleDiskWP(e.data.controller, e.data.drive);
            break;
        case 'setPlusDEnabled': {
            const want = !!e.data.value;
            if (want === plusdEnabled) break;
            plusdEnabled = want;
            if (want) {
                fetchRom('plusd.rom').then(() => {
                    attachPlusD();
                    postMessage({ message: 'plusdEnabledChanged', enabled: true });
                }).catch(err => {
                    console.error('+D enable failed:', err);
                    plusdEnabled = false;
                });
            } else {
                detachPlusD();
                postMessage({ message: 'plusdEnabledChanged', enabled: false });
            }
            break;
        }
        case 'setDISCiPLEEnabled': {
            const want = !!e.data.value;
            if (want === discipleEnabled) break;
            discipleEnabled = want;
            if (want) {
                fetchRom('disciple.rom').then(() => {
                    attachDISCiPLE();
                    postMessage({ message: 'discipleEnabledChanged', enabled: true });
                }).catch(err => {
                    console.error('DISCiPLE enable failed:', err);
                    discipleEnabled = false;
                });
            } else {
                detachDISCiPLE();
                postMessage({ message: 'discipleEnabledChanged', enabled: false });
            }
            break;
        }
        case 'setIF1Enabled': {
            const want = !!e.data.value;
            if (want === if1Enabled) break;
            if1Enabled = want;
            if (want) {
                fetchRom('if1-2.rom').then(() => {
                    attachInterface1();
                    postMessage({ message: 'if1EnabledChanged', enabled: true });
                }).catch(err => {
                    console.error('IF1 ROM if1-2.rom missing:', err);
                    if1Enabled = false;
                    postMessage({ message: 'if1EnabledChanged', enabled: false, error: 'rom-missing' });
                });
            } else {
                detachInterface1();
                postMessage({ message: 'if1EnabledChanged', enabled: false });
            }
            break;
        }
        case 'insertMicrodrive': {
            const data = new Uint8Array(e.data.data);
            const mdr = parseMdr(data.buffer);
            if (if1Instance) if1Instance.insertMicrodrive(e.data.drive, mdr);
            else pendingMdrInserts.push({ drive: e.data.drive, mdr });
            postMessage({ message: 'microdriveInserted', drive: e.data.drive });
            break;
        }
        case 'ejectMicrodrive':
            if (if1Instance) if1Instance.ejectMicrodrive(e.data.drive);
            postMessage({ message: 'microdriveEjected', drive: e.data.drive });
            break;
        case 'getMicrodrive': {
            const cart = if1Instance ? if1Instance.getCartridge(e.data.drive) : null;
            const buf = cart ? writeMdr(cart).buffer : null;
            postMessage({
                message: 'microdriveData',
                queryId: e.data.queryId,
                drive: e.data.drive,
                data: buf,
            }, buf ? [buf] : []);
            break;
        }
        case 'setMultifaceEnabled': {
            const want = !!e.data.value;
            if (want === multifaceEnabled) break;
            multifaceEnabled = want;
            if (want) {
                const variant = multifaceVariantFor(currentMachineId);
                const romFile = multifaceRomFor(variant);
                fetchRom(romFile).then(() => {
                    attachMultiface();
                    postMessage({ message: 'multifaceEnabledChanged', enabled: true, variant });
                }).catch(err => {
                    console.error(`Multiface ROM ${romFile} missing:`, err);
                    multifaceEnabled = false;
                    postMessage({ message: 'multifaceEnabledChanged', enabled: false, error: 'rom-missing', rom: romFile });
                });
            } else {
                detachMultiface();
                postMessage({ message: 'multifaceEnabledChanged', enabled: false });
            }
            break;
        }
        case 'multifaceRedButton':
            if (multifaceInstance) multifaceInstance.pressButton();
            break;
        case 'setDidaktikEnabled': {
            const want = !!e.data.value;
            if (want === didaktikEnabled) break;
            didaktikEnabled = want;
            if (want) {
                fetchRom('didaktik80.rom').then(() => {
                    attachDidaktik();
                    postMessage({ message: 'didaktikEnabledChanged', enabled: true });
                }).catch(err => {
                    console.error('Didaktik enable failed (ROM missing?):', err);
                    didaktikEnabled = false;
                    postMessage({ message: 'didaktikEnabledChanged', enabled: false, error: 'rom-missing' });
                });
            } else {
                detachDidaktik();
                postMessage({ message: 'didaktikEnabledChanged', enabled: false });
            }
            break;
        }
        case 'insertTimexDock': {
            try {
                const dck = parseDck(new Uint8Array(e.data.data).buffer);
                // Find the first DOCK bank block and pull chunks 0+1.
                const dockBlock = dck.blocks.find((b) => b.bank === 1);
                if (!dockBlock) throw new Error('No DOCK bank in .dck');
                const buf = new Uint8Array(0x4000);
                buf.fill(0xff);
                if (dockBlock.pages[0]) buf.set(dockBlock.pages[0], 0);
                if (dockBlock.pages[1]) buf.set(dockBlock.pages[1], 0x2000);
                timexDockCart = buf;
                applyTimexDock();
                core.reset();
                postMessage({ message: 'timexDockInserted' });
            } catch (err) {
                console.error('insertTimexDock failed:', err);
                postMessage({ message: 'timexDockError', error: String(err) });
            }
            break;
        }
        case 'ejectTimexDock':
            timexDockCart = null;
            applyTimexDock();
            core.reset();
            postMessage({ message: 'timexDockEjected' });
            break;
        case 'insertInterface2':
            interface2Cart = new Uint8Array(e.data.data).slice(0, 16384);
            applyInterface2();
            core.reset();
            postMessage({ message: 'interface2Inserted' });
            break;
        case 'ejectInterface2':
            clearInterface2();
            core.reset();
            postMessage({ message: 'interface2Ejected' });
            break;
        default:
            console.log('message received by worker:', e.data);
    }
};
