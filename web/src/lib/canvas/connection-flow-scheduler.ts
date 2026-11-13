type Draw = (time: number) => void;
const subscribers = new Set<Draw>();
let frame = 0;
let pending: Draw[] = [];
let cursor = 0;
let roundTime = 0;

function tick(time: number) {
    frame = 0;
    if (!subscribers.size) return;
    if (cursor >= pending.length) {
        pending = Array.from(subscribers);
        cursor = 0;
        roundTime = time;
    }
    const started = performance.now();
    // Share a small frame budget fairly. New selections can paint and receive
    // input before hundreds of light ribbons have all updated.
    while (cursor < pending.length && performance.now() - started < 5) {
        const draw = pending[cursor++];
        if (subscribers.has(draw)) draw(roundTime);
    }
    frame = requestAnimationFrame(tick);
}

export function subscribeConnectionFlow(draw: Draw) {
    subscribers.add(draw);
    if (!frame) frame = requestAnimationFrame(tick);
    return () => {
        subscribers.delete(draw);
        if (!subscribers.size) {
            cancelAnimationFrame(frame);
            frame = 0;
            pending = [];
            cursor = 0;
        }
    };
}
