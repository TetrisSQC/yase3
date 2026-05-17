/*
 * Peripheral bus.
 *
 * Each peripheral registers a Periph descriptor with
 * { portMask, portMatch, read, write, reset, snapshot, unsnapshot }. The
 * worker's IO funnel dispatches port reads/writes through the bus.
 */

export { PeriphBus, registerPeripheralFactory } from './bus.js';
