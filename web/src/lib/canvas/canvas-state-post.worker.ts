import type { CanvasAgentSnapshot } from "./canvas-agent-ops";

type Request = { id: number; endpoint: string; token: string; clientId: string; snapshot: CanvasAgentSnapshot | null };
const scope = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage: (reply: { id: number; ok: boolean }) => void };
scope.onmessage = ({ data }) => {
    const { id, endpoint, token, clientId, snapshot } = data;
    void (async () => {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
            signal: AbortSignal.timeout(15000),
        });
        scope.postMessage({ id, ok: response.ok });
    })().catch(() => scope.postMessage({ id, ok: false }));
};
