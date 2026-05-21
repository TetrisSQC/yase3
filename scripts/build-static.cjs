#!/usr/bin/env node
// Cross-platform replacement for the Unix build:static shell commands.
const fs = require('fs');
const path = require('path');

function cp(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

function cpGlob(pattern, dstDir) {
    const dir = path.dirname(pattern);
    const glob = path.basename(pattern);
    const re = new RegExp('^' + glob.replace(/\*/g, '.*') + '$');
    fs.mkdirSync(dstDir, { recursive: true });
    let found = false;
    for (const f of fs.readdirSync(dir)) {
        if (re.test(f)) {
            fs.copyFileSync(path.join(dir, f), path.join(dstDir, f));
            found = true;
        }
    }
    return found;
}

function cpDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            cpDir(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

fs.mkdirSync('dist/jsspeccy', { recursive: true });
cp('static/index.html', 'dist/index.html');
cp('static/favicon.ico', 'dist/favicon.ico');
cp('static/manifest.webmanifest', 'dist/manifest.webmanifest');
cp('static/service-worker.js', 'dist/service-worker.js');
cpGlob('static/icon-*.png', 'dist');
cp('README.md', 'dist/README.md');
cp('COPYING', 'dist/COPYING');
cp('COPYING.gpl3', 'dist/COPYING.gpl3');
cp('CREDITS.md', 'dist/CREDITS.md');
cp('CHANGELOG.md', 'dist/CHANGELOG.md');
cpDir('static/roms', 'dist/jsspeccy/roms');
cpDir('static/tapeloaders', 'dist/jsspeccy/tapeloaders');

console.log('build:static done');
