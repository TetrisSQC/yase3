/*
 * Menu tree. Top level: File, Options, Machine, Media, Help.
 *
 * Items that exist but aren't wired up yet are marked inactive: true so
 * the structure stays visible.
 *
 * Each leaf is a JS callback receiving the Emulator (passed as the menu
 * context). Disk / cartridge / tape sub-actions are pre-wired but resolve to
 * console messages until the disk + tape-edge phases land — this keeps the
 * tree shape stable while implementations fill in.
 */

import { MenuWidget } from './widgets/menu.js';
import { InfoWidget } from './widgets/info.js';
import { TapeBrowserWidget } from './widgets/tapeBrowser.js';
import { SearchWidget } from './widgets/search.js';
import { pickFile } from './widgets/filePicker.js';
import { DebuggerWidget } from './widgets/debugger.js';
import { MemoryWidget } from './widgets/memory.js';
import { PokefinderWidget } from './widgets/pokefinder.js';
import { writeZ80 } from '../snapshotExport.js';
import { writeRzx, readRzx } from '../rzx.js';
import { parseZ80File } from '../snapshot.js';
import { listMachines } from '../machines/index.js';

/**
 * Aspect-ratio choices for the CRT/display submenu. Value is a valid CSS
 * `aspect-ratio` property string (or 'stretch' to clear the constraint).
 */
const ASPECT_OPTIONS = [
    ['4:3 (CRT)',   '4 / 3'],
    ['5:4',         '5 / 4'],
    ['16:10',       '16 / 10'],
    ['16:9',        '16 / 9'],
    ['1:1 (pixel)', '1 / 1'],
    ['Stretch',     'stretch'],
];

function aspectLabel(value) {
    const m = ASPECT_OPTIONS.find(([, v]) => v === value);
    return m ? m[0].split(' ')[0] : (value ?? '');
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function openAnyFile(emu) {
    const file = await pickFile({
        accept: '.tap,.tzx,.szx,.z80,.sna,.zip,.dsk,.trd,.scl,.mgt,.img,.fdi,.udi,.opd',
    });
    if (!file) return;
    try {
        await emu.openFile(file);
    } catch (err) {
        console.error('openFile failed:', err);
    }
}

export function buildMenuTree(emu) {
    return [
        {
            label: 'File',
            submenu: () => [
                { label: 'Open...',          action: () => openAnyFile(emu) },
                { label: 'Search ZXInfo...',
                  action: () => {
                      emu.osd.pushWidget(new SearchWidget(
                          emu.osd.searchInput,
                          (url) => emu.openUrl(url).then(() => { if (!emu.isRunning) emu.start(); })
                      ));
                  },
                },
                { label: 'Save Snapshot (.z80)...',
                  action: async () => {
                      try {
                          const data = await emu.exportZ80Snapshot();
                          const pages = new Map(data.pages.map(({ num, bytes }) => [num, new Uint8Array(bytes)]));
                          const buf = writeZ80({
                              regs: new Uint16Array(data.regs),
                              pc: data.pc, iff1: data.iff1, iff2: data.iff2, im: data.im,
                              tstates: data.tstates, halted: data.halted,
                              machineModel: data.machineModel,
                              pagingFlags: data.pagingFlags,
                              borderColour: data.borderColour,
                              pages,
                          });
                          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                          downloadBlob(new Blob([buf], { type: 'application/octet-stream' }),
                                       `snapshot-${ts}.z80`);
                      } catch (err) {
                          console.error('Save Snapshot failed:', err);
                      }
                      return 'close';
                  },
                },
                { label: 'Screenshot...',
                  action: () => {
                      emu.canvas.toBlob((blob) => {
                          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                          downloadBlob(blob, `screenshot-${ts}.png`);
                      });
                      return 'close';
                  },
                },
                { separator: true },
                { label: 'Recording',
                    submenu: () => [
                        { label: 'Start RZX recording',
                          detail: () => emu.rzxMode === 'record' ? '<recording>' : '',
                          action: async () => {
                              // Capture the *initial* snapshot so playback can
                              // start from this state, not from after-the-fact.
                              emu._rzxStartSnap = await emu.exportZ80Snapshot();
                              emu.rzxStartRecord();
                              return 'close';
                          },
                        },
                        { label: 'Stop + Save RZX...',
                          action: async () => {
                              if (emu.rzxMode !== 'record') {
                                  alert('Not currently recording.');
                                  return 'close';
                              }
                              const recording = await emu.rzxGetRecording();
                              emu.rzxStopRecord();
                              if (!recording.frames.length) {
                                  alert('No frames captured.');
                                  return 'close';
                              }
                              // Use the snapshot captured at "Start recording"
                              // time so playback re-starts from there.
                              const snap = emu._rzxStartSnap ?? await emu.exportZ80Snapshot();
                              const pages = new Map(snap.pages.map(({ num, bytes }) => [num, new Uint8Array(bytes)]));
                              const snapBuf = writeZ80({
                                  regs: new Uint16Array(snap.regs),
                                  pc: snap.pc, iff1: snap.iff1, iff2: snap.iff2, im: snap.im,
                                  tstates: snap.tstates, halted: snap.halted,
                                  machineModel: snap.machineModel,
                                  pagingFlags: snap.pagingFlags,
                                  borderColour: snap.borderColour,
                                  pages,
                              });
                              const frames = recording.frames.map((f) => ({
                                  fetches: f.fetches,
                                  inputs: new Uint8Array(f.inputs),
                              }));
                              const rzxBuf = writeRzx(new Uint8Array(snapBuf), frames);
                              const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                              downloadBlob(new Blob([rzxBuf], { type: 'application/octet-stream' }),
                                           `recording-${ts}.rzx`);
                              return 'close';
                          },
                        },
                        { label: 'Play RZX...',
                          action: async () => {
                              const file = await pickFile({ accept: '.rzx' });
                              if (!file) return;
                              try {
                                  const buf = await file.arrayBuffer();
                                  const { snapshotZ80, frames } = readRzx(buf);
                                  // Load snapshot first.
                                  const snap = parseZ80File(snapshotZ80.buffer);
                                  await emu.loadSnapshot(snap);
                                  emu.rzxBeginPlayback(frames, snapshotZ80);
                                  if (!emu.isRunning) emu.start();
                              } catch (e) {
                                  alert('RZX load failed: ' + e.message);
                              }
                              return 'close';
                          },
                        },
                        { label: 'Stop playback',
                          detail: () => emu.rzxMode === 'playback' ? '<playing>' : '',
                          action: () => { emu.rzxStopPlayback(); return 'close'; },
                        },
                    ],
                },
                { separator: true },
                { label: 'Exit', action: () => { emu.exit?.(); return 'close'; } },
            ],
        },
        {
            label: 'Options',
            submenu: () => [
                { label: 'General',
                  submenu: () => [
                      { label: 'Tape Traps',
                        detail: () => emu.tapeTrapsEnabled ? 'on' : 'off',
                        action: () => { emu.setTapeTraps(!emu.tapeTrapsEnabled); },
                      },
                      { label: 'Auto-load Tapes',
                        detail: () => emu.autoLoadTapes ? 'on' : 'off',
                        action: () => { emu.setAutoLoadTapes(!emu.autoLoadTapes); },
                      },
                      { label: 'Tape Load Mode',
                        detail: () => emu.tapeAutoLoadMode === 'usr0' ? 'usr0' : 'default',
                        action: () => {
                            emu.setTapeAutoLoadMode(emu.tapeAutoLoadMode === 'usr0' ? 'default' : 'usr0');
                        },
                      },
                  ],
                },
                { label: 'Sound',
                  submenu: () => [
                      { label: 'Sound Enabled',
                        detail: () => emu.soundEnabled ? 'on' : 'off',
                        action: () => { emu.setSoundEnabled(!emu.soundEnabled); },
                      },
                  ],
                },
                { label: 'CRT Effect',
                  submenu: () => {
                      const s = () => emu.crtEffect?.settings ?? {};
                      return [
                          { label: 'Scanlines',
                            detail: () => s().scanlines  ? 'on' : 'off',
                            action: () => { emu.setCrtSettings({ scanlines:  !s().scanlines  }); },
                          },
                          { label: 'Vignette',
                            detail: () => s().vignette   ? 'on' : 'off',
                            action: () => { emu.setCrtSettings({ vignette:   !s().vignette   }); },
                          },
                          { label: 'Distortion',
                            detail: () => s().distortion ? 'on' : 'off',
                            action: () => { emu.setCrtSettings({ distortion: !s().distortion }); },
                          },
                          { label: 'Flicker',
                            detail: () => s().flicker    ? 'on' : 'off',
                            action: () => { emu.setCrtSettings({ flicker:    !s().flicker    }); },
                          },
                          { label: 'Pixel Shift',
                            detail: () => s().pixelshift ? 'on' : 'off',
                            action: () => { emu.setCrtSettings({ pixelshift: !s().pixelshift }); },
                          },
                          { separator: true },
                          { label: 'Aspect Ratio',
                            detail: () => aspectLabel(s().aspectRatio),
                            submenu: () => ASPECT_OPTIONS.map(([label, value]) => ({
                                label,
                                detail: () => s().aspectRatio === value ? '*' : '',
                                action: () => { emu.setCrtSettings({ aspectRatio: value }); },
                            })),
                          },
                      ];
                  },
                },
                { label: 'Fullscreen',
                  action: () => { emu.ui?.toggleFullscreen?.(); return 'close'; },
                  detail: () => '' },
                { separator: true },
                { label: 'Debugger...',
                  action: () => { emu.osd.pushWidget(new DebuggerWidget(emu)); },
                },
                { label: 'Memory Viewer...',
                  action: () => { emu.osd.pushWidget(new MemoryWidget(emu)); },
                },
                { label: 'Pokefinder...',
                  action: () => { emu.osd.pushWidget(new PokefinderWidget(emu)); },
                },
            ],
        },
        {
            label: 'Machine',
            submenu: () => [
                { label: 'Pause',
                  detail: () => emu.isRunning ? '' : '<paused>',
                  action: () => { emu.isRunning ? emu.pause() : emu.start(); return 'close'; } },
                { label: 'Reset',           action: () => { emu.reset(); return 'close'; } },
                { label: 'Hard Reset',      action: () => { emu.hardReset(); return 'close'; } },
                { separator: true },
                { label: 'Select Machine',
                  submenu: () => listMachines().map((m) => ({
                      label: m.name,
                      detail: () => emu.machineType === m.id ? '*' : '',
                      action: () => { emu.setMachine(m.id); return 'close'; },
                  })),
                },
                { separator: true },
                { label: 'NMI',                 action: () => { emu.triggerNmi(); return 'close'; } },
                { label: 'Multiface: Enable',
                  detail: () => emu.multifaceEnabled ? '<on>' : '<rom needed>',
                  action: () => {
                      emu.setMultifaceEnabled(!emu.multifaceEnabled);
                      return 'close';
                  },
                },
                { label: 'Multiface Red Button',
                  action: () => {
                      if (!emu.multifaceEnabled) return;
                      emu.multifaceRedButton();
                      return 'close';
                  },
                  detail: () => emu.multifaceEnabled ? '' : '<enable first>',
                },
                { label: 'Debugger...',
                  action: () => { emu.osd.pushWidget(new DebuggerWidget(emu)); },
                },
                { label: 'Memory Viewer...',
                  action: () => { emu.osd.pushWidget(new MemoryWidget(emu)); },
                },
                { label: 'Pokefinder...',
                  action: () => { emu.osd.pushWidget(new PokefinderWidget(emu)); },
                },
            ],
        },
        {
            label: 'Media',
            submenu: () => [
                { label: 'Tape',
                  submenu: () => [
                      { label: 'Open...',     action: () => openAnyFile(emu) },
                      { label: 'Play',        action: () => { emu.playTape?.(); return 'close'; },
                        detail: () => emu.tapeIsPlaying ? '<playing>' : '' },
                      { label: 'Stop',        action: () => { emu.stopTape?.(); return 'close'; } },
                      { label: 'Rewind',
                        action: () => { emu.rewindTape(); return 'close'; },
                      },
                      { label: 'Browse...',
                        action: async () => {
                            const blocks = await emu.getTapeBlocks();
                            emu.osd.pushWidget(new TapeBrowserWidget(blocks, (index) => {
                                emu.seekTape(index);
                            }));
                        },
                      },
                      { label: 'Write (download .tap)...',
                        detail: () => `${emu._recordedBlockCount ?? 0} blocks`,
                        action: async () => {
                            const data = await emu.getRecordedTape();
                            if (!data.blocks) {
                                alert('No tape blocks recorded yet. Start recording, run SAVE in BASIC, then come back.');
                                return 'close';
                            }
                            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                            downloadBlob(new Blob([data.data], { type: 'application/octet-stream' }),
                                         `recording-${ts}.tap`);
                            return 'close';
                        },
                      },
                      { separator: true },
                      { label: 'Record',
                        submenu: () => [
                            { label: 'Start',
                              detail: () => emu.tapeRecording ? '<recording>' : '',
                              action: () => { emu.startTapeRecording(); return 'close'; },
                            },
                            { label: 'Stop',
                              detail: () => emu.tapeRecording ? '' : '<stopped>',
                              action: () => { emu.stopTapeRecording(); return 'close'; },
                            },
                        ],
                      },
                  ],
                },
                { label: 'Disk',
                  submenu: () => [
                      { label: 'Beta Drive A',
                        submenu: () => diskDriveSubmenu(emu, 'beta', 0) },
                      { label: 'Beta Drive B',
                        submenu: () => diskDriveSubmenu(emu, 'beta', 1) },
                      { label: '+3 Drive A',
                        submenu: () => diskDriveSubmenu(emu, 'plus3', 0) },
                      { label: '+3 Drive B',
                        submenu: () => diskDriveSubmenu(emu, 'plus3', 1) },
                      { separator: true },
                      { label: '+D: Enable interface',
                        detail: () => emu.plusdEnabled ? '<on>' : '',
                        action: () => {
                            emu.setPlusDEnabled(!emu.plusdEnabled);
                            return 'close';
                        },
                      },
                      { label: '+D Drive 1',
                        submenu: () => diskDriveSubmenu(emu, 'plusd', 0) },
                      { label: '+D Drive 2',
                        submenu: () => diskDriveSubmenu(emu, 'plusd', 1) },
                      { separator: true },
                      { label: 'DISCiPLE: Enable interface',
                        detail: () => emu.discipleEnabled ? '<on>' : '',
                        action: () => {
                            emu.setDISCiPLEEnabled(!emu.discipleEnabled);
                            return 'close';
                        },
                      },
                      { label: 'DISCiPLE Drive 1',
                        submenu: () => diskDriveSubmenu(emu, 'disciple', 0) },
                      { label: 'DISCiPLE Drive 2',
                        submenu: () => diskDriveSubmenu(emu, 'disciple', 1) },
                      { separator: true },
                      { label: 'Didaktik: Enable interface',
                        detail: () => emu.didaktikEnabled ? '<on>' : '<rom needed>',
                        action: () => {
                            emu.setDidaktikEnabled(!emu.didaktikEnabled);
                            return 'close';
                        },
                      },
                      { label: 'Didaktik Drive A',
                        submenu: () => diskDriveSubmenu(emu, 'didaktik', 0) },
                      { label: 'Didaktik Drive B',
                        submenu: () => diskDriveSubmenu(emu, 'didaktik', 1) },
                      { separator: true },
                      { label: 'IF1: Enable',
                        detail: () => emu.if1Enabled ? '<on>' : '<rom needed>',
                        action: () => { emu.setIF1Enabled(!emu.if1Enabled); return 'close'; },
                      },
                      ...Array.from({ length: 8 }, (_, i) => ({
                          label: `Microdrive ${i + 1}`,
                          submenu: () => microdriveSubmenu(emu, i),
                      })),
                  ],
                },
                { label: 'Cartridge',
                  submenu: () => [
                      { label: 'Interface 2: Insert .rom...',
                        action: async () => {
                            const file = await pickFile({ accept: '.rom' });
                            if (!file) return;
                            const buf = await file.arrayBuffer();
                            emu.insertInterface2(buf);
                            if (!emu.isRunning) emu.start();
                            return 'close';
                        },
                      },
                      { label: 'Interface 2: Eject',
                        detail: () => emu.interface2Inserted ? '<inserted>' : '',
                        action: () => {
                            emu.ejectInterface2();
                            return 'close';
                        },
                      },
                      { separator: true },
                      { label: 'Timex Dock: Insert .dck...',
                        action: async () => {
                            const file = await pickFile({ accept: '.dck' });
                            if (!file) return;
                            const buf = await file.arrayBuffer();
                            emu.insertTimexDock(buf);
                            if (!emu.isRunning) emu.start();
                            return 'close';
                        },
                      },
                      { label: 'Timex Dock: Eject',
                        detail: () => emu.timexDockInserted ? '<inserted>' : '',
                        action: () => {
                            emu.ejectTimexDock();
                            return 'close';
                        },
                      },
                  ],
                },
            ],
        },
        {
            label: 'Help',
            submenu: () => [
                { label: 'Keyboard...',
                  action: () => {
                      emu.osd.pushWidget(new InfoWidget('Keyboard', [
                          'PC Key          Spectrum Key',
                          '----------------------------',
                          'A-Z, 0-9        A-Z, 0-9',
                          'Shift           Caps Shift',
                          'Right Alt       Symbol Shift',
                          'Enter           Enter',
                          'Backspace       Caps+0 (Delete)',
                          'Arrows          5/6/7/8 + Caps',
                          'Escape          Caps+Space (Break)',
                          '',
                          'F1              Open menu',
                      ]));
                  },
                },
                { label: 'About...',
                  action: () => {
                      emu.osd.pushWidget(new InfoWidget('About YaSE', [
                          'YaSE - Yet another Spectrum',
                          'Emulator (ZXenstein)',
                          '',
                          'Based on JSSpeccy 3',
                          'by Matt Westcott',
                          '',
                          'Ported from Fuse 1.8.0:',
                          '  +D, DISCiPLE, Didaktik',
                          '  Multiface 1/128/3',
                          '  Interface 1 + Microdrive',
                          '  Timex Dock .dck loader',
                          '',
                          'YaSE additions:',
                          '  CRT WebGL pixel shader',
                          '  Touch joystick',
                          '  ZX keyboard overlay',
                          '  Pokefinder',
                          '  RZX record/playback',
                          '  Debugger + breakpoints',
                          '  Memory viewer',
                          '  Z80 snapshot writer',
                          '  PWA / offline mode',
                          '',
                          'GPL v3 - see COPYING',
                          'CREDITS for full list',
                      ]));
                  },
                },
            ],
        },
    ];
}

function microdriveSubmenu(emu, drive) {
    return [
        { label: 'Insert .mdr...',
          action: async () => {
              const file = await pickFile({ accept: '.mdr' });
              if (!file) return;
              try { await emu.insertMicrodrive(drive, file); }
              catch (e) { console.error('insertMicrodrive:', e); }
              return 'close';
          },
        },
        { label: 'Eject',
          action: () => { emu.ejectMicrodrive(drive); return 'close'; },
        },
        { label: 'Save .mdr...',
          action: async () => {
              const data = await emu.getMicrodrive(drive);
              if (!data.data) {
                  alert('No cartridge in this drive.');
                  return 'close';
              }
              downloadBlob(new Blob([data.data], { type: 'application/octet-stream' }),
                           `microdrive-${drive + 1}.mdr`);
              return 'close';
          },
        },
    ];
}

function diskDriveSubmenu(emu, controller, drive) {
    const acceptByController = {
        beta:    '.trd',
        plus3:   '.dsk',
        plusd:   '.mgt,.img',
        disciple:'.mgt,.img',
        didaktik:'.d80,.d40,.mgt,.img',
    };
    const accept = acceptByController[controller] || '.trd,.dsk,.mgt,.img,.d80';
    return [
        { label: 'Insert...',
          action: async () => {
              const file = await pickFile({ accept });
              if (!file) return;
              try { await emu.insertDisk(controller, drive, file); }
              catch (e) { console.error('insertDisk:', e); }
              return 'close';
          },
        },
        { label: 'Eject',
          action: () => { emu.ejectDisk(controller, drive); return 'close'; },
        },
        { label: 'Save...',
          action: async () => {
              const data = await emu.saveDisk(controller, drive);
              if (!data.data) { alert('No disk in this drive.'); return 'close'; }
              const ext = controller === 'beta' ? 'trd' : 'mgt';
              const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              downloadBlob(new Blob([data.data], { type: 'application/octet-stream' }),
                           `${controller}-${drive}-${ts}.${ext}`);
              return 'close';
          },
        },
        { label: 'Flip',
          action: () => { emu.flipDisk(controller, drive); return 'close'; },
        },
        { label: 'Write Protect (toggle)',
          action: () => { emu.toggleDiskWriteProtect(controller, drive); return 'close'; },
        },
    ];
}

export function openMainMenu(osd, emu) {
    osd.pushWidget(new MenuWidget('YaSE', buildMenuTree(emu), { context: emu }));
}
