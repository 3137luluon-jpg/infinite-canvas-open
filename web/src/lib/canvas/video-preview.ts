// Decode one background preview at a time and yield to the selected player.
const covers = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const queue: Array<() => void> = [];
let active = 0;
let suspended = 0;
const consumers = new Map<string, Set<AbortSignal | undefined>>();

/** Give the selected video priority over background thumbnail decoding. */
export function suspendVideoPreviews() {
    suspended++;
    return () => { suspended = Math.max(0, suspended - 1); pump(); };
}

export function cachedVideoPreview(source: string) { return covers.get(source); }

function pump() {
    while (!suspended && active < 1 && queue.length) queue.shift()!();
}

export function loadVideoPreview(source: string, signal?: AbortSignal): Promise<string> {
    const cached = covers.get(source);
    if (cached) return Promise.resolve(cached);
    const users = consumers.get(source) || new Set<AbortSignal | undefined>();
    users.add(signal);
    consumers.set(source, users);
    const existing = pending.get(source);
    if (existing) return existing;
    const result = new Promise<string>((resolve) => {
        queue.push(() => {
            if (![...users].some(user => !user?.aborted)) { resolve(""); return; }
            active++;
            const video = document.createElement("video");
            let finished = false;
            const finish = (cover = "") => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                video.onloadeddata = null;
                video.onseeked = null;
                video.onerror = null;
                video.pause();
                video.removeAttribute("src");
                video.load();
                if (cover) {
                    if (covers.size >= 512) covers.delete(covers.keys().next().value!);
                    covers.set(source, cover);
                }
                active--;
                resolve(cover);
                pump();
            };
            const capture = () => {
                if (finished || !video.videoWidth || video.readyState < 2) return;
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.min(320, video.videoWidth);
                    canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
                    const context = canvas.getContext("2d");
                    if (!context) return finish();
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    finish(canvas.toDataURL("image/jpeg", 0.7));
                } catch { finish(); }
            };
            const timer = window.setTimeout(() => finish(), 12000);
            video.muted = true;
            video.playsInline = true;
            video.preload = "auto";
            if (/^https?:/i.test(source)) video.crossOrigin = "anonymous";
            video.onloadeddata = () => {
                // Avoid an encoded black opening frame where possible.
                if (Number.isFinite(video.duration) && video.duration > 0.15) video.currentTime = 0.1;
                else capture();
            };
            video.onseeked = capture;
            video.onerror = () => finish();
            video.src = source;
            video.load();
        });
    });
    pending.set(source, result);
    void result.then(() => { pending.delete(source); consumers.delete(source); });
    pump();
    return result;
}
