/** Add only a silent audio track: encoded video packets and their timestamps are copied unchanged. */
export async function ensureZealmanVideoAudioBlob(blob: Blob, signal?: AbortSignal): Promise<Blob> {
    const { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket, Output, BufferTarget, Mp4OutputFormat } = await import("mediabunny");
    const aborted = () => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };
    aborted();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    let output: InstanceType<typeof Output> | undefined;
    try {
        for (const track of await input.getAudioTracks()) {
            if (await new EncodedPacketSink(track).getFirstPacket()) return blob;
        }
        const video = await input.getPrimaryVideoTrack();
        const codec = await video?.getCodec();
        const decoderConfig = await video?.getDecoderConfig();
        const format = new Mp4OutputFormat();
        if (!video || !codec || !decoderConfig || !format.getSupportedCodecs().includes(codec)) throw new Error("参考视频格式不支持无损补充静音轨，请使用H.264 MP4。");
        const end = await video.computeDuration();
        const start = Math.max(0, await video.getFirstTimestamp());
        if (!Number.isFinite(end) || end <= start) throw new Error("参考视频没有有效时长。");
        const target = new BufferTarget();
        output = new Output({ format, target });
        const videoSource = new EncodedVideoPacketSource(codec);
        const audioSource = new EncodedAudioPacketSource("pcm-s16");
        output.addVideoTrack(videoSource, { rotation: await video.getRotation() });
        output.addAudioTrack(audioSource);
        await output.start();
        await Promise.all([
            (async () => {
                for await (const packet of new EncodedPacketSink(video).packets()) {
                    aborted();
                    await videoSource.add(packet, { decoderConfig });
                }
                videoSource.close();
            })(),
            (async () => {
                const rate = 48_000;
                const frames = Math.ceil((end - start) * rate);
                for (let offset = 0; offset < frames; offset += rate) {
                    aborted();
                    const count = Math.min(rate, frames - offset);
                    await audioSource.add(new EncodedPacket(new Uint8Array(count * 2), "key", start + offset / rate, count / rate), {
                        decoderConfig: { codec: "pcm-s16", sampleRate: rate, numberOfChannels: 1 },
                    });
                }
                audioSource.close();
            })(),
        ]);
        await output.finalize();
        aborted();
        if (!target.buffer) throw new Error("参考视频静音轨封装失败。");
        return new Blob([target.buffer], { type: "video/mp4" });
    } finally {
        input.dispose();
        if (output && output.state !== "finalized") await output.cancel().catch(() => undefined);
    }
}
