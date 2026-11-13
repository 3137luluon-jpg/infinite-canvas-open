import { useEffect, useRef } from "react";
export function CanvasVideoPlayer({ source, cover, nodeId, onPlayingChange, fit = "cover", onLoadedMetadata, onError }: { source: string; cover?: string; nodeId: string; onPlayingChange: (playing: boolean) => void; fit?: "cover" | "contain"; onLoadedMetadata?: (video: HTMLVideoElement) => void; onError?: () => void }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        // StrictMode replays setup after cleanup on the same element. Restore the source
        // removed below; React will not reapply an unchanged JSX src prop for that replay.
        video.src = source;
        video.load();
        return () => {
            video.pause();
            video.removeAttribute("src");
            video.load();
        };
    }, [source]);
    return <video ref={ref} poster={cover} preload="metadata" playsInline controls className={`h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"}`} data-canvas-video-id={nodeId}
        onLoadedMetadata={(event) => onLoadedMetadata?.(event.currentTarget)} onError={onError}
        onPlay={(event) => {
            document.querySelectorAll<HTMLVideoElement>("video[data-canvas-video-id]").forEach(video => { if (video !== event.currentTarget && !video.paused) video.pause(); });
            onPlayingChange(true);
        }} onPause={() => onPlayingChange(false)} onEnded={() => onPlayingChange(false)} />;
}
