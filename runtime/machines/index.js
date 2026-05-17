/*
 * Machine registry.
 *
 * Each machine is described by a MachineDef (see machineDef.js).
 * Register additional machines by importing them and calling registerMachine().
 *
 * The registry is the single source of truth for which machines the emulator
 * supports — UI, worker, and snapshot loaders all consult it.
 */

import { spec16 } from './spec16.js';
import { spec48 } from './spec48.js';
import { spec128 } from './spec128.js';
import { specplus2a } from './specplus2a.js';
import { specplus3 } from './specplus3.js';
import { specplus3e } from './specplus3e.js';
import { pentagon128 } from './pentagon128.js';
import { pentagon512 } from './pentagon512.js';
import { pentagon1024 } from './pentagon1024.js';
import { scorpion } from './scorpion.js';
import { tc2048 } from './tc2048.js';
import { tc2068 } from './tc2068.js';
import { ts2068 } from './ts2068.js';
import { specSe } from './specSe.js';

const machines = new Map();

export function registerMachine(def) {
    machines.set(def.id, def);
}

export function getMachine(id) {
    return machines.get(id);
}

export function listMachines() {
    return Array.from(machines.values());
}

export function hasMachine(id) {
    return machines.has(id);
}

// Built-in registrations.
registerMachine(spec16);
registerMachine(spec48);
registerMachine(spec128);
registerMachine(specplus2a);
registerMachine(specplus3);
registerMachine(specplus3e);
registerMachine(pentagon128);
registerMachine(pentagon512);
registerMachine(pentagon1024);
registerMachine(scorpion);
registerMachine(tc2048);
registerMachine(tc2068);
registerMachine(ts2068);
registerMachine(specSe);
