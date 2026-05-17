/*
 * File picker.
 *
 * Wraps a hidden <input type=file> appended to <body>. Triggered from within
 * an Enter keypress handler so the click() inherits the user-activation
 * required by modern browsers for file dialogs.
 *
 * Usage:
 *   const file = await pickFile({ accept: '.tap,.tzx,.szx,.z80,.sna' });
 *
 * Returns the selected File or null if cancelled.
 *
 * The cancel event is not universally reliable across browsers — we treat the
 * dialog as cancelled if 'change' is not received within a small grace period
 * after the window regains focus.
 */

let cachedInput = null;

function getInput() {
    if (!cachedInput) {
        cachedInput = document.createElement('input');
        cachedInput.type = 'file';
        cachedInput.style.position = 'fixed';
        cachedInput.style.left = '-9999px';
        cachedInput.style.opacity = '0';
        document.body.appendChild(cachedInput);
    }
    return cachedInput;
}

export function pickFile(opts = {}) {
    const input = getInput();
    input.accept = opts.accept ?? '';
    input.value = '';  // reset so re-selecting the same file fires change

    return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
            input.removeEventListener('change', onChange);
            input.removeEventListener('cancel', onCancel);
            window.removeEventListener('focus', onFocus);
        };
        const onChange = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(input.files?.[0] ?? null);
        };
        const onCancel = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(null);
        };
        const onFocus = () => {
            // Some browsers won't fire 'cancel'; if no file was picked within
            // 200ms of focus returning, treat as cancelled.
            setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(input.files?.[0] ?? null);
            }, 200);
        };

        input.addEventListener('change', onChange, { once: true });
        input.addEventListener('cancel', onCancel, { once: true });
        window.addEventListener('focus', onFocus, { once: true });

        input.click();
    });
}

/**
 * Drag-and-drop sink: returns a disposer. Calls onFile(file) for each dropped
 * file. Useful for attaching to the emulator container as a secondary path.
 */
export function installDropZone(element, onFile, opts = {}) {
    const accept = opts.accept;

    const matches = (file) => {
        if (!accept) return true;
        const extensions = accept.split(',').map(s => s.trim().toLowerCase());
        const name = file.name.toLowerCase();
        return extensions.some(ext => name.endsWith(ext));
    };

    const onDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (!files) return;
        for (const f of files) {
            if (matches(f)) onFile(f);
        }
    };

    element.addEventListener('dragover', onDragOver);
    element.addEventListener('drop', onDrop);

    return () => {
        element.removeEventListener('dragover', onDragOver);
        element.removeEventListener('drop', onDrop);
    };
}
