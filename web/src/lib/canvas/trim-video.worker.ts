import {
    ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output,
    Mp4InputFormat, QuickTimeInputFormat, WebMInputFormat, MatroskaInputFormat,
    Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, MkvOutputFormat,
} from "mediabunny";

self.onmessage = async (event: MessageEvent<{ blob: Blob; start: number; end: number }>) => {
    const { blob, start, end } = event.data;
    let input: Input | undefined;
    let conversion: Conversion | undefined;
    try {
        input = new Input({ source: new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024, useStreamReader: false }), formats: ALL_FORMATS });
        if (![start, end].every(Number.isFinite) || start < 0 || end <= start) throw new Error("请设置有效的起止时间");
        const duration = await input.computeDuration();
        if (end > duration + 0.05) throw new Error("截取时间超出视频范围");
        const sourceFormat = await input.getFormat();
        const format = sourceFormat instanceof QuickTimeInputFormat ? new MovOutputFormat()
            : sourceFormat instanceof Mp4InputFormat ? new Mp4OutputFormat()
            : sourceFormat instanceof WebMInputFormat ? new WebMOutputFormat()
            : sourceFormat instanceof MatroskaInputFormat ? new MkvOutputFormat() : null;
        if (!format) throw new Error("该视频格式暂不支持原格式无损截取，请使用 MP4、MOV、WebM 或 MKV");
        const target = new BufferTarget();
        const output = new Output({ format, target });
        conversion = await Conversion.init({
            input, output, trim: { start, end: Math.min(end, duration) },
            // Keep encoded audio/video intact. Never silently re-encode or drop a track.
            copy: { mode: "forced", shiftTolerance: 0 },
            video: { alpha: "keep" },
            showWarnings: false,
        });
        if (!conversion.isValid || conversion.discardedTracks.length || !output.tracks.some((track) => track.type === "video")) {
            throw new Error("该视频的编码暂不支持原格式无损截取，未降低画质或丢弃音轨");
        }
        let lastProgressAt = 0;
        conversion.onProgress = (value) => {
            const now = performance.now();
            if (value >= 1 || now - lastProgressAt >= 100) {
                lastProgressAt = now;
                self.postMessage({ progress: value });
            }
        };
        await conversion.execute();
        if (!target.buffer?.byteLength) throw new Error("没有生成视频片段");
        self.postMessage({ blob: new Blob([target.buffer], { type: format.mimeType }), extension: format.fileExtension.slice(1) });
    } catch (error) {
        await conversion?.cancel().catch(() => undefined);
        self.postMessage({ error: error instanceof Error ? error.message : "截取视频失败" });
    } finally {
        input?.dispose();
    }
};
