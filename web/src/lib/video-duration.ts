export const VIDEO_DURATION_AUTO = "auto";

export function integerDurationRange(min: number, max: number) {
    const start = Math.ceil(min);
    const end = Math.floor(max);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function isAutoVideoDuration(value: string | number | undefined) {
    const text = String(value ?? "").trim().toLowerCase();
    return text === VIDEO_DURATION_AUTO || text === "自动";
}

export function snapDuration(value: number, allowed: number[]) {
    if (!allowed.length) return Math.max(5, Math.min(15, Math.round(value) || 5));
    return allowed.reduce((best, current) => (Math.abs(current - value) < Math.abs(best - value) ? current : best));
}

/** 从提示词读取明确时长，再按模型允许档位吸附；没有写明时按镜头密度给出 5–15 秒。 */
export function inferVideoDurationFromPrompt(prompt: string, allowed: number[], fallback = allowed[0] || 5) {
    const parsed = readPromptDurationSeconds(prompt);
    if (parsed != null) return snapDuration(parsed, allowed);
    return snapDuration(heuristicDuration(prompt, fallback), allowed);
}

export function resolveVideoDuration(value: string | number | undefined, prompt: string, allowed: number[], fallback = allowed[0] || 5) {
    if (isAutoVideoDuration(value)) return inferVideoDurationFromPrompt(prompt, allowed, fallback);
    const seconds = Math.floor(Number(String(value ?? "").replace(/s$/i, "")));
    if (!Number.isFinite(seconds) || seconds <= 0) return allowed[0] || fallback;
    return snapDuration(seconds, allowed);
}

const durationNumber = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)`;
const secondsUnit = String.raw`(?:秒钟?|seconds?\b|secs?\b|s\b)`;

function durationNumberValue(value: string) {
    if (/^\d/.test(value)) return Number(value);
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let result = 0;
    let digit = 0;
    for (const char of value) {
        if (char === "十" || char === "百") { result += (digit || 1) * (char === "十" ? 10 : 100); digit = 0; }
        else digit = digits[char] ?? 0;
    }
    return result + digit;
}

function durationLiteral(value: string): number | null {
    const clock = value.match(/^(\d{1,3}):(\d{2}(?:\.\d+)?)/);
    if (clock && Number(clock[2]) < 60) return Number(clock[1]) * 60 + Number(clock[2]);
    const minutes = value.match(new RegExp(`^(${durationNumber})\\s*(?:分钟?|minutes?\\b|mins?\\b)(?:\\s*(${durationNumber})\\s*${secondsUnit})?`, "i"));
    if (minutes) return durationNumberValue(minutes[1]) * 60 + (minutes[2] ? durationNumberValue(minutes[2]) : 0);
    const seconds = value.match(new RegExp(`^(${durationNumber})(?:\\s*-?\\s*${secondsUnit})?`, "i"));
    const result = seconds ? durationNumberValue(seconds[1]) : 0;
    return result > 0 ? result : null;
}

/** Prefer declared whole-video duration over shot timings and incidental pauses. */
export function readPromptDurationSeconds(prompt: string) {
    const text = String(prompt || "").normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/@[^\s]+/g, " ");
    const labeledValue = (labels: string) => {
        const pattern = new RegExp(`(?:${labels})["'_*]*\\s*(?:[:=]|为|是|约|is|of)?\\s*["'_*]*\\s*`, "gi");
        for (const match of text.matchAll(pattern)) {
            const result = durationLiteral(text.slice(match.index! + match[0].length));
            if (result != null && result > 0) return result;
        }
        return null;
    };
    const total = labeledValue(String.raw`总时长|总秒数|总长度|全片时长|整片时长|整体时长|全长|\btotal[\s_-]*(?:video[\s_-]*)?(?:duration|seconds|length)\b|\boverall[\s_-]*duration\b`);
    if (total != null) return total;

    // "A 12-second video" / "12秒视频" wins over an earlier "hold for 2 seconds".
    const videoLength = text.match(new RegExp(`(${durationNumber})\\s*-?\\s*${secondsUnit}(?:\\s*-?\\s*long)?\\s*(?:的)?(?:video|clip|film|animation|视频|短片|影片)`, "i"));
    if (videoLength) return durationNumberValue(videoLength[1]);
    const videoLabel = labeledValue(String.raw`视频时长|片段时长|\bvideo[\s_-]*duration\b|\bclip[\s_-]*duration\b`);
    if (videoLabel != null) return videoLabel;

    // Read the end of the timeline, rather than treating the first shot as the whole video.
    const time = String.raw`\d+(?:\.\d+)?(?::\d{2}(?:\.\d+)?)?`;
    const ranges = new RegExp(`(?<![\\d.:])(${time})\\s*(${secondsUnit})?\\s*(?:-|~|至|到|→)\\s*(${time})\\s*(${secondsUnit})?`, "gi");
    let timelineEnd = 0;
    for (const match of text.matchAll(ranges)) {
        if (!match[2] && !match[4] && !match[1].includes(":") && !match[3].includes(":")) continue;
        const from = durationLiteral(match[1]);
        const to = durationLiteral(match[3]);
        if ((from ?? 0) < (to ?? 0)) timelineEnd = Math.max(timelineEnd, to!);
    }
    const labeled = labeledValue(String.raw`时长|\bduration(?:[\s_]*seconds|[\s_]*sec|[\s_]*s)?\b`);
    if (timelineEnd > 0) return Math.max(timelineEnd, labeled || 0);
    if (labeled != null) return labeled;

    const unit = text.match(new RegExp(`(?<![\\d.])(${durationNumber})\\s*-?\\s*${secondsUnit}`, "i"));
    return unit ? durationNumberValue(unit[1]) || null : null;
}

function heuristicDuration(prompt: string, fallback: number) {
    const text = String(prompt || "");
    if (/15\s*秒\s*一\s*组|一组\s*15|组限\s*15|15-second group/i.test(text)) return 15;
    if (/镜头\s*[2-9]|多镜头|一组|对白|台词|dialogue/i.test(text) || (text.match(/[“"「].{2,}[”"」]/g) || []).length >= 1) return 10;
    if ([...text].length > 800) return 12;
    if ([...text].length > 280) return 8;
    return fallback;
}
