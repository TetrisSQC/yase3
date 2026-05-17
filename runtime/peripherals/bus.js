/*
 * PeriphBus — peripheral registry. Each peripheral declares a port
 * mask/match pair plus read/write callbacks.
 *
 * On machine select the worker calls bus.clear(), then bus.register(spec) for
 * every entry in MachineDef.periph[]. Active peripherals are queried by the
 * wasm core via the host import wired up in runtime/worker.js (when that path
 * lands in a later phase).
 *
 * For the existing in-core peripherals (ULA, AY, Kempston, Beta128) the bus
 * entry is currently a no-op marker — port handling lives inline in the wasm
 * core, gated by the configureMachine() flags. New peripherals (UPD765 FDC,
 * WD1770 FDC, +D, DISCiPLE, Opus, SCLD) will provide real callbacks once their
 * worker-side state machines exist.
 */

/**
 * @typedef {(port:number, t:number) => number} PortReadFn
 * @typedef {(port:number, val:number, t:number) => void} PortWriteFn
 *
 * @typedef {Object} PeriphPort
 * @property {number} mask
 * @property {number} match
 * @property {PortReadFn} [read]
 * @property {PortWriteFn} [write]
 *
 * @typedef {Object} Peripheral
 * @property {string} type          Key matching MachineDef.periph[].type.
 * @property {PeriphPort[]} [ports] Port decoders.
 * @property {() => void} [reset]
 * @property {() => Uint8Array | null} [snapshot]
 * @property {(state: Uint8Array) => void} [unsnapshot]
 */

const peripheralFactories = new Map();

/**
 * Registers a peripheral factory. Factories are looked up by MachineDef.periph
 * type strings ('ula', 'ay', 'kempston', 'beta128', ...).
 *
 * @param {string} type
 * @param {(options?: Object) => Peripheral} factory
 */
export function registerPeripheralFactory(type, factory) {
    peripheralFactories.set(type, factory);
}

export class PeriphBus {
    constructor() {
        /** @type {Peripheral[]} */
        this.active = [];
    }

    clear() {
        this.active.forEach((p) => {
            if (p.reset) p.reset();
        });
        this.active = [];
    }

    /**
     * Instantiate a peripheral from its MachineDef spec and add it to the bus.
     *
     * @param {{ type: string, options?: Object }} spec
     */
    register(spec) {
        const factory = peripheralFactories.get(spec.type);
        if (!factory) {
            throw new Error(`PeriphBus: no factory for peripheral type '${spec.type}'`);
        }
        this.active.push(factory(spec.options));
    }

    /**
     * Dispatch a port read through the registered peripherals. First match
     * wins. Returns the byte read or null if no peripheral claimed the port
     * (caller falls back to floating-bus / unattached-port value).
     */
    readPort(port, t) {
        for (const p of this.active) {
            if (!p.ports) continue;
            for (const decode of p.ports) {
                if ((port & decode.mask) === decode.match && decode.read) {
                    return decode.read(port, t);
                }
            }
        }
        return null;
    }

    writePort(port, val, t) {
        let handled = false;
        for (const p of this.active) {
            if (!p.ports) continue;
            for (const decode of p.ports) {
                if ((port & decode.mask) === decode.match && decode.write) {
                    decode.write(port, val, t);
                    handled = true;
                }
            }
        }
        return handled;
    }

    reset() {
        for (const p of this.active) {
            if (p.reset) p.reset();
        }
    }
}

// Built-in markers for in-core peripherals. No port decoders — wasm core
// handles their I/O inline. These exist so configureMachine logging /
// snapshot enumeration can name them, and so that future replacement of any of
// them with a JS-side implementation is a one-file change.
import { createBeta128 } from '../disk/beta128.js';
import { createPlus3Fdc } from '../disk/plus3Fdc.js';

registerPeripheralFactory('ula',      () => ({ type: 'ula' }));
registerPeripheralFactory('ay',       () => ({ type: 'ay' }));
registerPeripheralFactory('kempston', () => ({ type: 'kempston' }));
registerPeripheralFactory('beta128',  () => createBeta128());
registerPeripheralFactory('upd765',   () => createPlus3Fdc());
// Stubs — full implementations arrive in a future phase.
registerPeripheralFactory('wd1770',   () => ({ type: 'wd1770' }));
registerPeripheralFactory('plusd',    () => ({ type: 'plusd' }));
registerPeripheralFactory('disciple', () => ({ type: 'disciple' }));
registerPeripheralFactory('opus',     () => ({ type: 'opus' }));
registerPeripheralFactory('scld',     () => ({ type: 'scld' }));
