import EventEmitter from 'events';
import fileDialog from 'file-dialog';
import JSZip from 'jszip';

import { DisplayHandler } from './render.js';
import { UIController } from './ui.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { writeZ80 } from './snapshotExport.js';
import { TAPFile, TZXFile } from './tape.js';
import { StandardKeyboardHandler, RecreatedZXSpectrumHandler } from './keyboard.js';
import { AudioHandler } from './audio.js';
import { getMachine } from './machines/index.js';
import { Osd } from './osd/osd.js';
import { openMainMenu } from './osd/menuTree.js';
import { installDropZone } from './osd/widgets/filePicker.js';
import { CRTEffect } from './crt.js';
import { TouchControls } from './touchControls.js';
import { ZXKeyboard } from './zxKeyboard.js';

import openIcon from './icons/open.svg';
import resetIcon from './icons/reset.svg';
import playIcon from './icons/play.svg';
import pauseIcon from './icons/pause.svg';
import fullscreenIcon from './icons/fullscreen.svg';
import exitFullscreenIcon from './icons/exitfullscreen.svg';
import tapePlayIcon from './icons/tape_play.svg';
import tapePauseIcon from './icons/tape_pause.svg';

const scriptUrl = document.currentScript.src;

class Emulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.worker = new Worker(new URL('jsspeccy-worker.js', scriptUrl));
        this.keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
        if (this.keyboardEnabled) {
            this.keyboardHandler = (opts.keyboardMap == 'recreated')
                ? new RecreatedZXSpectrumHandler(this.worker, opts.keyboardEventRoot || document)
                : new StandardKeyboardHandler(this.worker, opts.keyboardEventRoot || document);
        }
        this.displayHandler = new DisplayHandler(this.canvas);
        this.audioHandler = new AudioHandler();
        this.isRunning = false;
        this.isReady = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = opts.autoLoadTapes || false;
        this.tapeAutoLoadMode = opts.tapeAutoLoadMode || 'default';  // or usr0
        this.tapeIsPlaying = false;
        this.tapeTrapsEnabled = ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true;
        this.soundEnabled = true;

        this.msPerFrame = 20;

        this.isExecutingFrame = false;
        this.nextFrameTime = null;
        this.machineType = null;

        this.nextFileOpenID = 0;
        this.fileOpenPromiseResolutions = {};
        this.nextQueryID = 0;
        this.queryResolvers = {};

        this.onReadyHandlers = [];

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.setMachine(opts.machine || 128);
                        this.setTapeTraps(this.tapeTrapsEnabled);
                        if (opts.openUrl) {
                            this.openUrlList(opts.openUrl).catch(err => {
                                alert(err);
                            }).then(() => {
                                if (opts.autoStart) this.start();
                            });
                        } else if (opts.autoStart) {
                            this.start();
                        }

                        this.isReady = true;
                        for (let i=0; i < this.onReadyHandlers.length; i++) {
                            this.onReadyHandlers[i]();
                        }
                    });
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameCompleted(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }

                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    if (this.isRunning) {
                        const time = performance.now();
                        if (time > this.nextFrameTime) {
                            /* running at full blast - start next frame but adjust time base
                            to give it the full time allocation */
                            this.runFrame();
                            this.nextFrameTime = time + this.msPerFrame;
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'fileOpened':
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes) {
                        const def = getMachine(this.machineType);
                        const loader = def?.tapeLoaders?.[this.tapeAutoLoadMode] ?? def?.tapeLoaders?.default;
                        if (loader) {
                            this.openUrl(new URL(loader, scriptUrl));
                        }
                        if (!this.tapeTrapsEnabled) {
                            this.playTape();
                        }
                    }
                    this.fileOpenPromiseResolutions[e.data.id]({
                        mediaType: e.data.mediaType,
                    });
                    if (e.data.mediaType == 'tape') {
                        this.emit('openedTapeFile');
                    }
                    break;
                case 'playingTape':
                    this.tapeIsPlaying = true;
                    this.emit('playingTape');
                    break;
                case 'stoppedTape':
                    this.tapeIsPlaying = false;
                    this.emit('stoppedTape');
                    break;
                case 'tapeBlocks':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data.blocks);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'exportSnapshotData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'breakpointHit':
                    this.pause();
                    this.emit('breakpointHit', e.data.pc);
                    break;
                case 'debugMemData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'savedDiskData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'microdriveData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'rzxRecordingData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'rzxStateChanged':
                    this.rzxMode = e.data.mode;
                    this.emit('rzxStateChanged', e.data.mode);
                    break;
                case 'recordedTapeData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'tapeRecordingChanged':
                    this.tapeRecording = !!e.data.recording;
                    this.emit('tapeRecordingChanged', this.tapeRecording);
                    break;
                case 'pokefinderSamplesData':
                    if (this.queryResolvers[e.data.queryId]) {
                        this.queryResolvers[e.data.queryId](e.data);
                        delete this.queryResolvers[e.data.queryId];
                    }
                    break;
                case 'pokefinderState':
                    this.emit('pokefinderState', e.data);
                    break;
                default:
                    console.log('message received by host:', e.data);
            }
        }
        this.worker.postMessage({
            message: 'loadCore',
            baseUrl: scriptUrl,
        })
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.nextFrameTime = performance.now();
            if (this.keyboardEnabled) {
                this.keyboardHandler.start();
            }
            this.audioHandler.start();
            this.focus();
            this.emit('start');
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    }

    focus() {
        if (this.keyboardEnabled && this.keyboardHandler.rootElement.focus) {
            this.keyboardHandler.rootElement.focus();
        }
    }

    setKeyboardEventRoot(newRootElement) {
        if (this.keyboardEnabled) {
            this.keyboardHandler.setRootElement(newRootElement);
        }
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            if (this.keyboardEnabled) {
                this.keyboardHandler.stop();
            }
            this.audioHandler.stop();
            this.emit('pause');
        }
    }

    async loadRom(url, page) {
        const response = await fetch(new URL(url, scriptUrl));
        const data = new Uint8Array(await response.arrayBuffer());
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
        });
    }

    async loadRoms() {
        await this.loadRom('roms/128-0.rom', 8);
        await this.loadRom('roms/128-1.rom', 9);
        await this.loadRom('roms/48.rom', 10);
        await this.loadRom('roms/pentagon-0.rom', 12);
        await this.loadRom('roms/trdos.rom', 13);
    }


    runFrame() {
        this.isExecutingFrame = true;
        const frameBuffer = this.displayHandler.getNextFrameBuffer();

        if (this.audioHandler.isActive && this.soundEnabled) {
            const [audioBufferLeft, audioBufferRight] = this.audioHandler.frameBuffers;

            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
                audioBufferLeft,
                audioBufferRight,
            }, [frameBuffer, audioBufferLeft, audioBufferRight]);
        } else {
            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
            }, [frameBuffer]);
        }
    }

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
            this.crtEffect?.render();
        }
        if (this.isRunning) {
            if (time > this.nextFrameTime && !this.isExecutingFrame) {
                this.runFrame();
                this.nextFrameTime += this.msPerFrame;
            }
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    };

    setMachine(type) {
        if (!getMachine(type)) {
            console.warn(`setMachine: unknown machine id ${type}, falling back to 48`);
            type = 48;
        }
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.machineType = type;
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
    }

    hardReset() {
        this.worker.postMessage({message: 'hardReset'});
    }

    triggerNmi() {
        this.worker.postMessage({message: 'nmi'});
    }

    setKempstonState(state) {
        this.worker.postMessage({message: 'setKempstonState', state: state & 0xff});
    }

    /**
     * Insert an Interface 2 ROM cartridge (16K .rom). Overrides ROM bank 0;
     * survives reset and machine switch until ejectInterface2() is called.
     * @param {ArrayBuffer|Uint8Array} data
     */
    insertInterface2(data) {
        const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        // IF2 carts target 48K timing/paging — force 48 if running another model.
        if (this.machineType !== 48) this.setMachine(48);
        this.worker.postMessage({ message: 'insertInterface2', data: buf }, [buf]);
        this.interface2Inserted = true;
        this.emit('interface2Changed', true);
    }

    ejectInterface2() {
        this.worker.postMessage({ message: 'ejectInterface2' });
        this.interface2Inserted = false;
        this.emit('interface2Changed', false);
    }

    /** Insert a Timex Dock cartridge (.dck). Switches to TC2068 if not on a
     *  Timex machine already so the SCLD paging is active. */
    insertTimexDock(data) {
        const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const TIMEX_IDS = new Set([15, 17, 13]);   // SE, TC2068, TS2068
        if (!TIMEX_IDS.has(this.machineType)) this.setMachine(17); // TC2068 default
        this.worker.postMessage({ message: 'insertTimexDock', data: buf }, [buf]);
        this.timexDockInserted = true;
        this.emit('timexDockChanged', true);
    }

    ejectTimexDock() {
        this.worker.postMessage({ message: 'ejectTimexDock' });
        this.timexDockInserted = false;
        this.emit('timexDockChanged', false);
    }

    /** Request the worker to assemble a .z80 snapshot of current state. */
    exportZ80Snapshot() {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'exportSnapshot', queryId: id });
        });
    }

    setBreakpoint(addr, on) {
        this.worker.postMessage({ message: 'debugSetBreakpoint', addr: addr & 0xffff, on: !!on });
    }
    clearBreakpoints() {
        this.worker.postMessage({ message: 'debugClearBreakpoints' });
    }
    debugPoke(addr, val) {
        this.worker.postMessage({ message: 'debugPoke', addr: addr & 0xffff, val: val & 0xff });
    }
    rzxStartRecord() {
        this.worker.postMessage({ message: 'rzxStartRecord' });
        this.rzxMode = 'record';
        this.emit('rzxStateChanged', 'record');
    }
    rzxStopRecord() {
        this.worker.postMessage({ message: 'rzxStopRecord' });
        this.rzxMode = 'idle';
    }
    rzxGetRecording() {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'rzxGetRecording', queryId: id });
        });
    }
    rzxBeginPlayback(frames, snapshotZ80) {
        // Frames is array of { fetches, inputs: Uint8Array }
        // Snapshot bytes already loaded by caller (loadSnapshotFromStruct).
        const transferable = frames.map((f) => ({ fetches: f.fetches, inputs: f.inputs.buffer }));
        this.worker.postMessage({ message: 'rzxBeginPlayback', frames: transferable, snapshotZ80 },
                                transferable.map((f) => f.inputs));
        this.rzxMode = 'playback';
        this.emit('rzxStateChanged', 'playback');
    }
    rzxStopPlayback() {
        this.worker.postMessage({ message: 'rzxStopPlayback' });
        this.rzxMode = 'idle';
    }

    startTapeRecording() {
        this.worker.postMessage({ message: 'startTapeRecording' });
        this.tapeRecording = true;
        this.emit('tapeRecordingChanged', true);
    }
    stopTapeRecording() {
        this.worker.postMessage({ message: 'stopTapeRecording' });
        this.tapeRecording = false;
        this.emit('tapeRecordingChanged', false);
    }
    getRecordedTape() {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'getRecordedTape', queryId: id });
        });
    }

    pokefinderReset() {
        this.worker.postMessage({ message: 'pokefinderReset' });
    }
    pokefinderNarrow(mode, value) {
        this.worker.postMessage({ message: 'pokefinderNarrow', mode, value });
    }
    pokefinderSamples(limit) {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'pokefinderSamples', queryId: id, limit });
        });
    }

    debugReadMem(base, length) {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'debugReadMem', queryId: id, base: base & 0xffff, length });
        });
    }

    /** Enable / disable the +D disk interface. */
    setPlusDEnabled(on) {
        this.worker.postMessage({ message: 'setPlusDEnabled', value: !!on });
        this.plusdEnabled = !!on;
        this.emit('plusdEnabledChanged', this.plusdEnabled);
    }

    /** Enable / disable the DISCiPLE disk interface. */
    setDISCiPLEEnabled(on) {
        this.worker.postMessage({ message: 'setDISCiPLEEnabled', value: !!on });
        this.discipleEnabled = !!on;
        this.emit('discipleEnabledChanged', this.discipleEnabled);
    }

    /** Enable / disable the Didaktik D80 disk interface. ROM must be present
     *  at static/roms/didaktik80.rom — not redistributable. */
    setDidaktikEnabled(on) {
        this.worker.postMessage({ message: 'setDidaktikEnabled', value: !!on });
        this.didaktikEnabled = !!on;
        this.emit('didaktikEnabledChanged', this.didaktikEnabled);
    }

    /** Enable / disable Interface 1 (+ Microdrive). ROM file `if1-2.rom`
     *  must be in static/roms/. Not redistributable. */
    setIF1Enabled(on) {
        this.worker.postMessage({ message: 'setIF1Enabled', value: !!on });
        this.if1Enabled = !!on;
        this.emit('if1EnabledChanged', this.if1Enabled);
    }

    async insertMicrodrive(drive, file) {
        const buf = await file.arrayBuffer();
        this.worker.postMessage({ message: 'insertMicrodrive', drive, data: buf }, [buf]);
        this.microdriveInserted = this.microdriveInserted || new Set();
        this.microdriveInserted.add(drive);
    }
    ejectMicrodrive(drive) {
        this.worker.postMessage({ message: 'ejectMicrodrive', drive });
        this.microdriveInserted?.delete(drive);
    }
    getMicrodrive(drive) {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'getMicrodrive', queryId: id, drive });
        });
    }

    /** Enable / disable the Multiface (variant picked from current machine).
     *  ROM files: mf1.rom / mf128.rom / mf3.rom in static/roms/. */
    setMultifaceEnabled(on) {
        this.worker.postMessage({ message: 'setMultifaceEnabled', value: !!on });
        this.multifaceEnabled = !!on;
        this.emit('multifaceEnabledChanged', this.multifaceEnabled);
    }

    /** Press the Multiface red button — triggers NMI and pages in Multiface. */
    multifaceRedButton() {
        this.worker.postMessage({ message: 'multifaceRedButton' });
    }

    rewindTape() {
        this.worker.postMessage({message: 'rewindTape'});
    }

    seekTape(index) {
        this.worker.postMessage({message: 'seekTape', index});
    }

    getTapeBlocks() {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({message: 'getTapeBlocks', queryId: id});
        });
    }

    loadSnapshot(snapshot) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTAPFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    /**
     * Insert a disk image into a given controller's drive.
     * @param {string} controller  'beta' | 'plus3' | 'plusd' | 'disciple' | 'opus'
     * @param {number} drive       0..3
     * @param {File|Blob} file
     */
    async insertDisk(controller, drive, file) {
        const name = file.name?.toLowerCase() ?? '';
        let kind = null;
        if (name.endsWith('.trd')) kind = 'trd';
        else if (name.endsWith('.dsk')) kind = 'dsk';
        else if (name.endsWith('.mgt')) kind = 'mgt';
        else if (name.endsWith('.img')) kind = 'img';
        else if (name.endsWith('.d80')) kind = 'd80';
        else if (name.endsWith('.d40')) kind = 'd40';
        else throw new Error(`Unsupported disk extension: ${name}`);
        const data = new Uint8Array(await file.arrayBuffer());
        this.worker.postMessage({
            message: 'insertDisk',
            controller, drive, kind, data,
        }, [data.buffer]);
    }

    ejectDisk(controller, drive) {
        this.worker.postMessage({ message: 'ejectDisk', controller, drive });
    }

    saveDisk(controller, drive) {
        const id = this.nextQueryID++;
        return new Promise((resolve) => {
            this.queryResolvers[id] = resolve;
            this.worker.postMessage({ message: 'saveDisk', queryId: id, controller, drive });
        });
    }
    flipDisk(controller, drive) {
        this.worker.postMessage({ message: 'flipDisk', controller, drive });
    }
    toggleDiskWriteProtect(controller, drive) {
        this.worker.postMessage({ message: 'wpDisk', controller, drive });
    }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    return this.openTAPFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        const boundOpener = async () => {
                            const buf = await file.async('arraybuffer');
                            return opener(buf);
                        };
                        openers.push(boundOpener);
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    // TODO: prompt to choose a file
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            }
        }
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            return opener(buf).catch(err => {alert(err);});
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url) {
        const opener = this.getFileOpener(url.toString());
        if (!opener) {
            throw 'Unrecognised file type: ' + url.toString().split('/').pop();
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`fetch ${url} → ${response.status} ${response.statusText}`);
        }
        const buf = await response.arrayBuffer();
        // Catch parser failures so a bad fetch (HTML error page, partial file)
        // doesn't surface as a silent emulator crash — the search dialog
        // surfaces the rejection via its onLoad try/catch.
        try {
            return await opener(buf);
        } catch (err) {
            console.error('openUrl: opener failed for', url, err);
            throw err;
        }
    }
    async openUrlList(urls) {
        if (typeof(urls) === 'string') {
            return await this.openUrl(urls);
        } else {
            for (const url of urls) {
                await this.openUrl(url);
            }
        }
    }

    setAutoLoadTapes(val) {
        this.autoLoadTapes = val;
        this.emit('setAutoLoadTapes', val);
    }
    setTapeAutoLoadMode(val) {
        this.tapeAutoLoadMode = val;
        this.emit('setTapeAutoLoadMode', val);
    }
    setSoundEnabled(val) {
        this.soundEnabled = !!val;
        this.emit('setSoundEnabled', this.soundEnabled);
    }

    setCrtSettings(patch) {
        if (this.crtEffect) this.crtEffect.setSettings(patch);
        this.emit('setCrtSettings', this.crtEffect?.settings ?? {});
    }
    setTapeTraps(val) {
        this.tapeTrapsEnabled = val;
        this.worker.postMessage({
            message: 'setTapeTraps',
            value: val,
        })
        this.emit('setTapeTraps', val);
    }

    playTape() {
        this.worker.postMessage({
            message: 'playTape',
        });
    }
    stopTape() {
        this.worker.postMessage({
            message: 'stopTape',
        });
    }

    exit() {
        this.pause();
        this.worker.terminate();
    }
}

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;

    const keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
    const uiEnabled = ('uiEnabled' in opts) ? opts.uiEnabled : true;
    const openMenuOnReady = !!opts.openMenuOnReady;

    // Persistent settings (machine choice, CRT effect, tape/sound toggles)
    // live in a single JSON blob under SETTINGS_KEY so every preference is
    // restored across page reloads.
    const SETTINGS_KEY = 'jsspeccy.settings';
    const LEGACY_MACHINE_KEY = 'jsspeccy.lastMachine';
    const loadSettings = () => {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) return JSON.parse(raw);
            const legacyM = localStorage.getItem(LEGACY_MACHINE_KEY);
            if (legacyM !== null) return { machine: parseInt(legacyM, 10) };
        } catch (e) {}
        return {};
    };
    const saveSettings = (obj) => {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch (e) {}
    };
    const stored = loadSettings();

    const explicitMachine = ('machine' in opts) ? opts.machine : null;
    const initialMachine = explicitMachine ?? stored.machine ?? 128;
    const initialTapeTraps =
        ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled :
        ('tapeTrapsEnabled' in stored) ? stored.tapeTrapsEnabled : true;
    const initialAutoLoad =
        ('autoLoadTapes' in opts) ? opts.autoLoadTapes :
        stored.autoLoadTapes ?? false;
    const initialAutoLoadMode =
        opts.tapeAutoLoadMode ?? stored.tapeAutoLoadMode ?? 'default';

    const emu = new Emulator(canvas, {
        machine: initialMachine,
        autoStart: opts.autoStart || false,
        autoLoadTapes: initialAutoLoad,
        tapeAutoLoadMode: initialAutoLoadMode,
        openUrl: opts.openUrl,
        tapeTrapsEnabled: initialTapeTraps,
        keyboardEnabled: keyboardEnabled,
        keyboardMap: opts.keyboardMap || 'standard',
    });

    // Settings persistence — currentSettings reads CRT off emu.crtEffect,
    // which is created later (after the OSD block). Wiring of the persist
    // listeners is therefore deferred until after CRT creation; see below.
    const currentSettings = () => ({
        machine: emu.machineType,
        tapeTrapsEnabled: emu.tapeTrapsEnabled,
        autoLoadTapes: emu.autoLoadTapes,
        tapeAutoLoadMode: emu.tapeAutoLoadMode,
        soundEnabled: emu.soundEnabled,
        crt: emu.crtEffect?.settings ?? null,
    });
    const persist = () => saveSettings(currentSettings());

    const ui = new UIController(container, emu, {
        zoom: opts.zoom || 1,
        sandbox: opts.sandbox,
        uiEnabled: uiEnabled,
    });

    // No-chrome mode: make the canvas fill the parent container with
    // aspect-ratio preservation. appContainer is flex-centered so the
    // aspect-fitted canvas sits in the middle when the viewport ratio differs
    // from the chosen aspect (e.g. 16:9 viewport with 4:3 canvas → pillars).
    // The OSD / CRT overlays are absolutely positioned, so flex doesn't move
    // them. Suppress the giant centre play button.
    if (!uiEnabled) {
        ui.appContainer.style.width = '100%';
        ui.appContainer.style.height = '100%';
        ui.appContainer.style.display = 'flex';
        ui.appContainer.style.alignItems = 'center';
        ui.appContainer.style.justifyContent = 'center';
        ui.appContainer.style.background = '#000';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '100%';
        canvas.style.objectFit = 'contain';
        canvas.style.background = '#000';   // kill default white canvas bg
        if (ui.startButton) ui.startButton.style.display = 'none';
        emu.on('pause', () => {
            if (ui.startButton) ui.startButton.style.display = 'none';
        });
        // UIController.setZoom (called on fullscreen exit) forces a fixed
        // 320 × zoom pixel size that overrides our aspect-ratio computed box.
        // Stub so it can't fight the no-chrome flex layout.
        ui.setZoom = () => {};
        // Recompute CRT sizing across a few frames after fullscreen toggle
        // (Safari needs > 1 frame post-exit before clientHeight reflects the
        // new viewport).
        const recomputeAfterFullscreen = () => {
            ui.appContainer.style.width  = '100%';
            ui.appContainer.style.height = '100%';
            canvas.style.width  = '';
            canvas.style.height = '';
            emu.crtEffect?.applyAspectRatio();
        };
        document.addEventListener('fullscreenchange', () => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    recomputeAfterFullscreen();
                    setTimeout(recomputeAfterFullscreen, 50);
                    setTimeout(recomputeAfterFullscreen, 200);
                });
            });
        });
    }

    if (keyboardEnabled) {
        if (ui.appContainer.tabIndex == -1) {
            ui.appContainer.tabIndex = 0;  // allow receiving focus for keyboard events
        }
        emu.setKeyboardEventRoot(ui.appContainer);
    }

    // Sound is independent of CRT (audio handler exists by now). Restore here.
    if ('soundEnabled' in stored) {
        emu.setSoundEnabled(stored.soundEnabled);
    }

    if (uiEnabled) {
        const fileMenu = ui.menuBar.addMenu('File');
        if (!opts.sandbox) {
            fileMenu.addItem('Open...', () => {
                openFileDialog();
            });
            fileMenu.addItem('Find games...', () => {
                openGameBrowser();
            });
            const autoLoadTapesMenuItem = fileMenu.addItem('Auto-load tapes', () => {
                emu.setAutoLoadTapes(!emu.autoLoadTapes);
                emu.focus();
            });
            const updateAutoLoadTapesCheckbox = () => {
                if (emu.autoLoadTapes) {
                    autoLoadTapesMenuItem.setCheckbox();
                } else {
                    autoLoadTapesMenuItem.unsetCheckbox();
                }
            }
            emu.on('setAutoLoadTapes', updateAutoLoadTapesCheckbox);
            updateAutoLoadTapesCheckbox();
        }

        const tapeTrapsMenuItem = fileMenu.addItem('Instant tape loading', () => {
            emu.setTapeTraps(!emu.tapeTrapsEnabled);
            emu.focus();
        });

        const updateTapeTrapsCheckbox = () => {
            if (emu.tapeTrapsEnabled) {
                tapeTrapsMenuItem.setCheckbox();
            } else {
                tapeTrapsMenuItem.unsetCheckbox();
            }
        }
        emu.on('setTapeTraps', updateTapeTrapsCheckbox);
        updateTapeTrapsCheckbox();

        const machineMenu = ui.menuBar.addMenu('Machine');
        const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
            emu.setMachine(48);
            emu.focus();
        });
        const machine128Item = machineMenu.addItem('Spectrum 128K', () => {
            emu.setMachine(128);
            emu.focus();
        });
        const machinePentagonItem = machineMenu.addItem('Pentagon 128', () => {
            emu.setMachine(5);
            emu.focus();
        });
        const displayMenu = ui.menuBar.addMenu('Display');

        const zoomItemsBySize = {
            1: displayMenu.addItem('100%', () => {ui.setZoom(1); emu.focus();}),
            2: displayMenu.addItem('200%', () => {ui.setZoom(2); emu.focus();}),
            3: displayMenu.addItem('300%', () => {ui.setZoom(3); emu.focus();}),
        }
        const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
            ui.enterFullscreen();
        })
        const setZoomCheckbox = (factor) => {
            if (factor == 'fullscreen') {
                fullscreenItem.setBullet();
                for (let i in zoomItemsBySize) {
                    zoomItemsBySize[i].unsetBullet();
                }
            } else {
                fullscreenItem.unsetBullet();
                for (let i in zoomItemsBySize) {
                    if (parseInt(i) == factor) {
                        zoomItemsBySize[i].setBullet();
                    } else {
                        zoomItemsBySize[i].unsetBullet();
                    }
                }
            }
        }

        ui.on('setZoom', setZoomCheckbox);
        setZoomCheckbox(ui.zoom);

        emu.on('setMachine', (type) => {
            if (type == 48) {
                machine48Item.setBullet();
                machine128Item.unsetBullet();
                machinePentagonItem.unsetBullet();
            } else if (type == 128) {
                machine48Item.unsetBullet();
                machine128Item.setBullet();
                machinePentagonItem.unsetBullet();
            } else { // pentagon
                machine48Item.unsetBullet();
                machine128Item.unsetBullet();
                machinePentagonItem.setBullet();
            }
        });

        if (!opts.sandbox) {
            ui.toolbar.addButton(openIcon, {label: 'Open file'}, () => {
                openFileDialog();
            });
        }
        ui.toolbar.addButton(resetIcon, {label: 'Reset'}, () => {
            emu.reset();
        });
        const pauseButton = ui.toolbar.addButton(playIcon, {label: 'Unpause'}, () => {
            if (emu.isRunning) {
                emu.pause();
            } else {
                emu.start();
            }
        });
        emu.on('pause', () => {
            pauseButton.setIcon(playIcon);
            pauseButton.setLabel('Unpause');
        });
        emu.on('start', () => {
            pauseButton.setIcon(pauseIcon);
            pauseButton.setLabel('Pause');
        });
        const tapeButton = ui.toolbar.addButton(tapePlayIcon, {label: 'Start tape'}, () => {
            if (emu.tapeIsPlaying) {
                emu.stopTape();
            } else {
                emu.playTape();
            }
        });
        tapeButton.disable();
        emu.on('openedTapeFile', () => {
            tapeButton.enable();
        });
        emu.on('playingTape', () => {
            tapeButton.setIcon(tapePauseIcon);
            tapeButton.setLabel('Stop tape');
        });
        emu.on('stoppedTape', () => {
            tapeButton.setIcon(tapePlayIcon);
            tapeButton.setLabel('Start tape');
        });

        const fullscreenButton = ui.toolbar.addButton(
            fullscreenIcon,
            {label: 'Enter full screen mode', align: 'right'},
            () => {
                ui.toggleFullscreen();
            }
        )

        ui.on('setZoom', (factor) => {
            if (factor == 'fullscreen') {
                fullscreenButton.setIcon(exitFullscreenIcon);
                fullscreenButton.setLabel('Exit full screen mode');
            } else {
                fullscreenButton.setIcon(fullscreenIcon);
                fullscreenButton.setLabel('Enter full screen mode');
            }
        });
    }

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then(() => {
                if (emu.isInitiallyPaused) emu.start();
                emu.focus();
            }).catch((err) => {alert(err);});
        });
    }

    const openGameBrowser = () => {
        emu.pause();
        const body = ui.showDialog();
        body.innerHTML = `
            <label>Find games</label>
            <form>
                <input type="search">
                <button type="submit">Search</button>
            </form>
            <div class="results">
            </div>
        `;
        const input = body.querySelector('input');
        const searchButton = body.querySelector('button');
        const searchForm = body.querySelector('form');
        const resultsContainer = body.querySelector('.results');

        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            searchButton.innerText = 'Searching...';
            const searchTerm = input.value.replace(/[^\w\s\-\']/, '');

            const encodeParam = (key, val) => {
                return encodeURIComponent(key) + '=' + encodeURIComponent(val);
            }

            const searchUrl = (
                'https://archive.org/advancedsearch.php?'
                + encodeParam('q', 'collection:softwarelibrary_zx_spectrum title:"' + searchTerm + '"')
                + '&' + encodeParam('fl[]', 'creator')
                + '&' + encodeParam('fl[]', 'identifier')
                + '&' + encodeParam('fl[]', 'title')
                + '&' + encodeParam('rows', '50')
                + '&' + encodeParam('page', '1')
                + '&' + encodeParam('output', 'json')
            )
            fetch(searchUrl).then(response => {
                searchButton.innerText = 'Search';
                return response.json();
            }).then(data => {
                resultsContainer.innerHTML = '<ul></ul><p>- powered by <a href="https://archive.org/">Internet Archive</a></p>';
                const ul = resultsContainer.querySelector('ul');
                const results = data.response.docs;
                results.forEach(result => {
                    const li = document.createElement('li');
                    ul.appendChild(li);
                    const resultLink = document.createElement('a');
                    resultLink.href = '#';
                    resultLink.innerText = result.title;
                    const creator = document.createTextNode(' - ' + result.creator)
                    li.appendChild(resultLink);
                    li.appendChild(creator);
                    resultLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        fetch(
                            'https://archive.org/metadata/' + result.identifier
                        ).then(response => response.json()).then(data => {
                            let chosenFilename = null;
                            data.files.forEach(file => {
                                const ext = file.name.split('.').pop().toLowerCase();
                                if (ext == 'z80' || ext == 'sna' || ext == 'tap' || ext == 'tzx' || ext == 'szx') {
                                    chosenFilename = file.name;
                                }
                            });
                            if (!chosenFilename) {
                                alert('No loadable file found');
                            } else {
                                const finalUrl = 'https://cors.archive.org/cors/' + result.identifier + '/' + chosenFilename;
                                emu.openUrl(finalUrl).catch((err) => {
                                    alert(err);
                                }).then(() => {
                                    ui.hideDialog();
                                    emu.focus();
                                    emu.start();
                                });
                            }
                        })
                    })
                })
            })
        })
        input.focus();
    }

    const exit = () => {
        emu.exit();
        ui.unload();
    }

    /*
     * OSD overlay. F1 toggles. While open, keys are
     * captured and routed to the OSD; emulation is paused.
     */
    // Auto-open debugger on breakpoint hit so the user always sees the stop.
    emu.on('breakpointHit', () => {
        // Lazy require: avoid pulling debugger widget into the boot path.
        import('./osd/widgets/debugger.js').then(({ DebuggerWidget }) => {
            if (!emu.osd.isOpen) emu.osd.pushWidget(new DebuggerWidget(emu));
        });
    });

    const osd = new Osd(ui.appContainer, emu.canvas, {
        pause: () => emu.pause(),
        resume: () => emu.start(),
        isRunning: () => emu.isRunning,
    });
    emu.osd = osd;
    emu.ui = ui;
    // Hand the existing archive.org-backed game browser to the OSD so the
    // Search menu can launch it. Closes the OSD before showing the DOM
    // dialog so the user can type into the search input.
    emu.openGameBrowser = () => {
        osd.close();
        openGameBrowser();
    };

    const crtEffect = new CRTEffect(ui.appContainer, emu.canvas);
    emu.crtEffect = crtEffect;

    // Kempston touch overlay (transparent D-pad + A/B). Auto-hides when idle.
    // Suppressed unless a coarse pointer is present, or opts.touchControls === true.
    const wantTouch =
        ('touchControls' in opts) ? !!opts.touchControls
        : (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (wantTouch) {
        emu.touchControls = new TouchControls(ui.appContainer, emu);
    }

    // On-screen ZX Spectrum keyboard. Auto-shown in portrait orientation
    // (configurable via opts.zxKeyboard: false to disable, true to force on
    // both orientations). Toggle FAB lives next to the menu FAB.
    const wantKbd =
        ('zxKeyboard' in opts) ? !!opts.zxKeyboard
        : (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (wantKbd) {
        emu.zxKeyboard = new ZXKeyboard(ui.appContainer, emu, { autoPortrait: true });

        const kbdFab = document.createElement('button');
        kbdFab.innerHTML = `<svg viewBox="0 0 48 48" width="22" height="22" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
<path d="M8.14,14.94v4.53h4.53V14.94Zm6.8,0v4.53h4.53V14.94Zm6.79,0v4.53h4.54V14.94Zm6.8,0v4.53h4.53V14.94Zm6.8,0v4.53h4.53V14.94ZM8.14,21.73v4.54h4.53V21.73Zm6.8,0v4.54h4.53V21.73Zm6.79,0v4.54h4.54V21.73Zm6.8,0v4.54h4.53V21.73Zm6.8,0v4.54h4.53V21.73ZM8.14,28.53v4.53h4.53V28.53Zm6.8,0v4.53H33.06V28.53Zm20.39,0v4.53h4.53V28.53Z"/>
<path d="M43.5,35.5v-23a2,2,0,0,0-2-2H6.5a2,2,0,0,0-2,2v23a2,2,0,0,0,2,2h35A2,2,0,0,0,43.5,35.5Z" fill="none" stroke="currentColor" stroke-width="2.5"/>
</svg>`;
        kbdFab.title = 'Toggle keyboard';
        kbdFab.style.cssText = [
            'position:absolute', 'top:6px', 'right:48px',
            'width:36px', 'height:36px', 'padding:0',
            'background:rgba(255,255,255,0.18)', 'color:#fff',
            'border:1px solid rgba(255,255,255,0.35)', 'border-radius:6px',
            'cursor:pointer',
            'display:flex','align-items:center','justify-content:center',
            'z-index:45', 'touch-action:manipulation',
            '-webkit-tap-highlight-color:transparent',
        ].join(';');
        ui.appContainer.appendChild(kbdFab);
        kbdFab.addEventListener('click', () => emu.zxKeyboard.toggle());
    }

    // Now that crtEffect exists, restore its stored settings and arm the
    // persist listeners. Registering listeners only after the restore call
    // avoids the bootstrapping problem where the initial setMachine fired
    // before crtEffect was created and would have written crt:null into the
    // saved blob.
    if (stored.crt) {
        emu.setCrtSettings(stored.crt);
    }
    emu.on('setMachine',        persist);
    emu.on('setTapeTraps',      persist);
    emu.on('setAutoLoadTapes',  persist);
    emu.on('setSoundEnabled',   persist);
    emu.on('setCrtSettings',    persist);
    persist();  // sync once so first writeback covers all current fields

    // Floating hamburger menu button for touch devices (no physical F1 key).
    const menuFab = document.createElement('button');
    menuFab.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
<line x1="4" y1="7"  x2="20" y2="7"/>
<line x1="4" y1="12" x2="20" y2="12"/>
<line x1="4" y1="17" x2="20" y2="17"/>
</svg>`;
    menuFab.title = 'Menu (F1)';
    menuFab.style.cssText = [
        'position:absolute', 'top:6px', 'right:6px',
        'width:36px', 'height:36px', 'padding:0',
        'background:rgba(255,255,255,0.18)', 'color:#fff',
        'border:1px solid rgba(255,255,255,0.35)', 'border-radius:6px',
        'cursor:pointer',
        'display:flex','align-items:center','justify-content:center',
        'z-index:45', 'touch-action:manipulation',
        '-webkit-tap-highlight-color:transparent',
    ].join(';');
    ui.appContainer.appendChild(menuFab);
    menuFab.addEventListener('click', () => {
        if (osd.isOpen) osd.close(); else openMainMenu(osd, emu);
    });
    // Hide FAB while menu is open (OSD draws its own close path)
    const updateFab = () => { /* menuFab.style.opacity = osd.isOpen ? '0' : '1'; */};
    emu.on('start', updateFab);
    emu.on('pause', updateFab);

    const osdKeyListener = (event) => {
        if (event.type !== 'keydown') return;
        if (event.key === 'F1') {
            event.preventDefault();
            event.stopPropagation();
            if (osd.isOpen) osd.close();
            else openMainMenu(osd, emu);
            return;
        }
        if (osd.isOpen) {
            const consumed = osd.onKeyDown(event);
            if (consumed) {
                event.preventDefault();
                event.stopPropagation();
            } else {
                // Always swallow keys while OSD is open so the Spectrum
                // doesn't see them while a widget is open.
                event.preventDefault();
                event.stopPropagation();
            }
        }
    };
    // Capture phase so we intercept before the StandardKeyboardHandler.
    // Listen on both appContainer (when emulator has focus) and document
    // (so F1 works even when focus is elsewhere on the page).
    if (ui.appContainer) {
        ui.appContainer.addEventListener('keydown', osdKeyListener, true);
    }
    document.addEventListener('keydown', osdKeyListener, true);

    // Drag-and-drop file open onto the emulator surface.
    installDropZone(ui.appContainer, async (file) => {
        try { await emu.openFile(file); } catch (e) { console.error(e); }
    }, { accept: '.tap,.tzx,.szx,.z80,.sna,.zip,.dsk,.trd,.scl,.mgt,.img,.fdi,.udi,.opd' });

    /*
        if (openMenuOnReady) {
            emu.onReadyHandlers.push(() => {
                // Slight defer so the first frame has painted before the OSD
                // captures pause state.
                setTimeout(() => openMainMenu(osd, emu), 3000);
            });
        }
    */

    /*
        const benchmarkElement = document.getElementById('benchmark');
        setInterval(() => {
            benchmarkElement.innerText = (
                "Running at " + benchmarkRunCount + "fps, rendering at "
                + benchmarkRenderCount + "fps"
            );
            benchmarkRunCount = 0;
            benchmarkRenderCount = 0;
        }, 1000)
    */

    return {
        setZoom: (zoom) => {ui.setZoom(zoom);},
        toggleFullscreen: () => {ui.toggleFullscreen();},
        enterFullscreen: () => {ui.enterFullscreen();},
        exitFullscreen: () => {ui.exitFullscreen();},
        setMachine: (model) => {emu.setMachine(model);},
        openFileDialog: () => {openFileDialog();},
        openUrl: (url) => {
            emu.openUrl(url).catch((err) => {alert(err);});
        },
        loadSnapshotFromStruct: (snapshot) => {
            emu.loadSnapshot(snapshot);
        },
        onReady: (callback) => {
            if (emu.isReady) {
                callback();
            } else {
                emu.onReadyHandlers.push(callback);
            }
        },
        exit: () => {exit();},
        openMenu: () => { openMainMenu(osd, emu); },
        closeMenu: () => { osd.close(); },
    };
};
