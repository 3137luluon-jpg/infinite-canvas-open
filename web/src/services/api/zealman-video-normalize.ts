import { ensureZealmanVideoAudioBlob } from "./zealman-video-audio";

const MP4_MIME_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
const WEBM_MIME_TYPES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];

function supportedRecorderMimeType() {
    if (typeof MediaRecorder === "undefined") return "";
    return [...MP4_MIME_TYPES, ...WEBM_MIME_TYPES].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function ensureAudio(dataUrl: string, signal?: AbortSignal) {
    const original = await fetch(dataUrl, { signal }).then((response) => response.blob());
    const blob = await ensureZealmanVideoAudioBlob(original, signal);
    if (blob === original) return { dataUrl, type: "" };
    const converted = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取补充静音轨后的参考视频。"));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("参考视频封装失败。"));
        reader.readAsDataURL(blob);
    });
    return { dataUrl: converted, type: blob.type };
}

/** Re-encode WebM references to a broadly decodable H.264/VP8 file before ZEALMAN upload. */
export async function normalizeZealmanVideoReference(dataUrl: string, signal?: AbortSignal) {
    if (!/^data:video\/webm(?:;|,)/i.test(dataUrl)) return /^data:video\/(?:mp4|quicktime|x-m4v)(?:;|,)/i.test(dataUrl) ? ensureAudio(dataUrl, signal) : { dataUrl, type: "" };
    const mimeType = supportedRecorderMimeType();
    if (!mimeType) throw new Error("当前浏览器不支持转换 WebM 参考视频；请先另存为 H.264 MP4，再连接到画布视频节点。");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const sourceBlob = await fetch(dataUrl, { signal }).then((response) => response.blob());
    const sourceUrl = URL.createObjectURL(sourceBlob);
    const video = document.createElement("video");
    const captureVideoStream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = sourceUrl;

    let recorder: MediaRecorder | undefined;
    let outputStream: MediaStream | undefined;
    let animationFrame = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => (video.videoWidth && video.videoHeight ? resolve() : reject(new Error("参考视频没有有效画面尺寸，无法转换。")));
            video.onerror = () => reject(new Error("浏览器无法解码这段 WebM 参考视频；请先另存为 H.264 MP4。"));
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            video.load();
        });
        if (!captureVideoStream || !HTMLCanvasElement.prototype.captureStream) throw new Error("当前浏览器不支持参考视频转码；请先另存为 H.264 MP4。");

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建参考视频转换画布。");
        const canvasStream = canvas.captureStream(30);
        const sourceStream = captureVideoStream.call(video);
        outputStream = new MediaStream([...canvasStream.getVideoTracks(), ...sourceStream.getAudioTracks()]);
        recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
        };
        const output = new Promise<Blob>((resolve, reject) => {
            recorder!.onerror = () => reject(new Error("参考视频转换失败；请先另存为 H.264 MP4。"));
            recorder!.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
                blob.size ? resolve(blob) : reject(new Error("参考视频转换结果为空；请先另存为 H.264 MP4。"));
            };
        });
        void output.catch(() => undefined);
        const drawFrame = () => {
            if (video.ended || video.paused) return;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            animationFrame = requestAnimationFrame(drawFrame);
        };
        recorder.start(250);
        await video.play();
        drawFrame();
        await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error("参考视频转换超时；请先另存为 H.264 MP4。")), Math.max(30_000, video.duration * 2_000));
            video.onended = () => {
                window.clearTimeout(timeout);
                resolve();
            };
            signal?.addEventListener("abort", () => {
                window.clearTimeout(timeout);
                reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
        });
        recorder.stop();
        const blob = await output;
        const convertedType = mimeType.split(";")[0];
        const convertedDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("无法读取转换后的视频文件。"));
            reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("转换后的视频格式无效。")));
            reader.readAsDataURL(new Blob([blob], { type: convertedType }));
        });
        const normalized = await ensureAudio(convertedDataUrl, signal);
        return { dataUrl: normalized.dataUrl, type: normalized.type || convertedType };
    } catch (error) {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        throw error;
    } finally {
        cancelAnimationFrame(animationFrame);
        outputStream?.getTracks().forEach((track) => track.stop());
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(sourceUrl);
    }
}
