/** Background reports wait for the current canvas gesture to finish. */
export function canvasInteractionActive() {
    return typeof document !== "undefined" && Boolean(document.querySelector(
        '[data-canvas-panning="true"],[data-canvas-viewport-changing="true"],[data-canvas-node-interacting="true"]',
    ));
}
