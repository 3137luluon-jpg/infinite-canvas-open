import { type ReactNode } from "react";
import { Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution } from "@/lib/seedance-video";
import { getFeimiaoSpec, isFeimiaoModelConfig, normalizeFeimiaoAspectRatio, normalizeFeimiaoDuration, normalizeFeimiaoResolution } from "@/lib/feimiao-video";
import { inferVideoDurationFromPrompt, integerDurationRange, isAutoVideoDuration, readPromptDurationSeconds, VIDEO_DURATION_AUTO } from "@/lib/video-duration";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelCapabilityOf, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { autodlVideoSettings } from "@/lib/autodl-workflow";
import { DOLA_RATIOS, dolaDurations, dolaRatio } from "@/lib/dola-video";
import { AGNES_VIDEO_RATIOS, agnesRatio, isAgnesConfig } from "@/lib/agnes";
import { resolveVideoDuration } from "@/lib/video-duration";
import { isRunningHubConfig, RUNNINGHUB_RATIOS, RUNNINGHUB_RESOLUTIONS } from "@/lib/runninghub";

const RATIO_CATALOG = [
    { value: "auto", label: "Auto", width: 20, height: 14 },
    { value: "16:9", label: "16:9", width: 20, height: 11 },
    { value: "4:3", label: "4:3", width: 18, height: 14 },
    { value: "1:1", label: "1:1", width: 14, height: 14 },
    { value: "3:4", label: "3:4", width: 14, height: 18 },
    { value: "9:16", label: "9:16", width: 11, height: 20 },
    { value: "21:9", label: "21:9", width: 22, height: 9 },
] as const;

const RESOLUTION_CATALOG = [
    { value: "480p", label: "480P" },
    { value: "720p", label: "720P" },
    { value: "1080p", label: "1080P" },
    { value: "4k", label: "4K" },
] as const;
const AUTODL_RESOLUTIONS = [{ value: "480p", label: "480P" }, { value: "768p", label: "768P" }];

const sizeOptions = [
    { value: "1280x720", labelKey: "landscape", width: 1280, height: 720 },
    { value: "720x1280", labelKey: "portrait", width: 720, height: 1280 },
    { value: "1024x1024", labelKey: "square", width: 1024, height: 1024 },
    { value: "1792x1024", labelKey: "widescreen", width: 1792, height: 1024 },
    { value: "1024x1792", labelKey: "tall", width: 1024, height: 1792 },
    { value: "auto", labelKey: "auto", width: 0, height: 0 },
];

export const videoResolutionOptions = RESOLUTION_CATALOG.map((item) => ({ value: item.value.replace(/p$/i, "").replace("4k", "2160"), label: item.label }));
export const videoSizeOptions = sizeOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.video.sizes.${item.labelKey}`); } }));
export const videoSecondOptions = ["4", "5", "6", "8", "10", "12", "15"];

type VideoSettingsPanelProps = {
    followsReferences?: boolean;
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    prompt?: string;
};

type VideoStudioOptions = {
    ratio: string;
    allowedRatios: string[];
    autoValue: string;
    allowsAuto: boolean;
    resolution: string;
    allowedResolutions: string[];
    duration: number;
    durationMin: number;
    durationMax: number;
    durationStep: number;
    snapDurations?: number[];
    durationAuto: boolean;
    extras?: ReactNode;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-full space-y-4 rounded-xl px-0.5 py-0.5", prompt = "", followsReferences = false }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const videoModelValue = modelCapabilityOf(config, config.model) === "video" ? config.model : config.videoModel;
    const requestConfig = resolveModelRequestConfig(config, videoModelValue);
    if (requestConfig.apiFormat === "dola") return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={event => event.stopPropagation()}>
                {showTitle ? <div className="text-sm font-semibold">DOLA 视频设置</div> : null}
                <SettingGroup title="画幅比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">{DOLA_RATIOS.map(ratio => <ChoiceButton key={ratio} disabled={false} selected={config.size === ratio || ((config.size === "auto" || config.size === "1280x720") && ratio === "16:9")} theme={theme} onClick={() => onConfigChange("size", ratio)}>{ratio}</ChoiceButton>)}</div>
                </SettingGroup>
                <SettingGroup title="时长" color={theme.node.muted}>
                    <div className="flex gap-2">{dolaDurations(requestConfig.model).map(seconds => <ChoiceButton key={seconds} disabled={false} selected={String(seconds) === config.videoSeconds || (isAutoVideoDuration(config.videoSeconds) && seconds === 10)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(seconds))}>{seconds} 秒</ChoiceButton>)}</div>
                </SettingGroup>
                <div className="text-xs opacity-65">时长仅通过参数提交，提示词保持原文。分辨率和声音由 DOLA 管理器决定。</div>
            </div>
        </ImageSettingsTheme>
    );
    const options = resolveStudioOptions(config, videoModelValue, onConfigChange, theme, t, prompt);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-sm font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <VideoStudioLayout theme={theme} options={options} onConfigChange={onConfigChange} followsReferences={followsReferences} />
            </div>
        </ImageSettingsTheme>
    );
}

function VideoStudioLayout({
    theme,
    options,
    onConfigChange,
    followsReferences,
}: {
    theme: CanvasTheme;
    options: VideoStudioOptions;
    onConfigChange: VideoSettingsPanelProps["onConfigChange"];
    followsReferences?: boolean;
}) {
    const { t } = useTranslation();
    const setDuration = (raw: number) => {
        const snapped = options.snapDurations?.length ? snapToAllowed(raw, options.snapDurations) : Math.min(options.durationMax, Math.max(options.durationMin, Math.round(raw)));
        onConfigChange("videoSeconds", String(snapped));
    };

    return (
        <div className="space-y-4">
            {followsReferences ? <div className="text-xs opacity-75">比例跟随参考图 · 时长跟随完整参考视频</div> : <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2">
                    {RATIO_CATALOG.map((item) => {
                        const isAuto = item.value === "auto";
                        const storedValue = isAuto ? options.autoValue : item.value;
                        const allowed = isAuto ? options.allowsAuto : options.allowedRatios.includes(item.value);
                        const selected = allowed && (isAuto ? options.ratio === options.autoValue : options.ratio === item.value);
                        return (
                            <RatioCard
                                key={item.value}
                                label={item.label}
                                width={item.width}
                                height={item.height}
                                selected={selected}
                                disabled={!allowed}
                                theme={theme}
                                onClick={() => onConfigChange("size", storedValue)}
                            />
                        );
                    })}
                </div>
            </SettingGroup>}
            <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2">
                    {(options.allowedResolutions.includes("768p") ? AUTODL_RESOLUTIONS : RESOLUTION_CATALOG).map((item) => {
                        const allowed = options.allowedResolutions.some((value) => sameResolution(value, item.value));
                        const selected = allowed && sameResolution(options.resolution, item.value);
                        return (
                            <ChoiceButton
                                key={item.value}
                                selected={selected}
                                disabled={!allowed}
                                theme={theme}
                                onClick={() => onConfigChange("vquality", item.value)}
                            >
                                {item.label}
                            </ChoiceButton>
                        );
                    })}
                </div>
            </SettingGroup>
            {!followsReferences && <SettingGroup title={t("settingsPanels.video.duration")} color={theme.node.muted}>
                <DurationSlider value={options.duration} min={options.durationMin} max={options.durationMax} step={options.durationStep} auto={options.durationAuto} theme={theme} onChange={setDuration} onAuto={() => onConfigChange("videoSeconds", VIDEO_DURATION_AUTO)} />
            </SettingGroup>}
            {options.extras}
        </div>
    );
}

function resolveStudioOptions(
    config: AiConfig,
    videoModelValue: string,
    onConfigChange: VideoSettingsPanelProps["onConfigChange"],
    theme: CanvasTheme,
    t: (key: string) => string,
    prompt: string,
): VideoStudioOptions {
    if (isRunningHubConfig(resolveModelRequestConfig(config, videoModelValue))) {
        return {
            ratio: normalizeSeedanceRatio(config.size), allowedRatios: RUNNINGHUB_RATIOS, autoValue: "adaptive", allowsAuto: true,
            resolution: normalizeSeedanceResolution(config.vquality), allowedResolutions: RUNNINGHUB_RESOLUTIONS,
            duration: resolveVideoDuration(config.videoSeconds || "5", prompt, integerDurationRange(4, 15), 5),
            durationMin: 4, durationMax: 15, durationStep: 1, durationAuto: isAutoVideoDuration(config.videoSeconds),
            extras: <SettingGroup title={t("settingsPanels.video.output")} color={theme.node.muted}>
                <SwitchRow label={t("settingsPanels.video.generateAudio")} checked={boolConfig(config.videoGenerateAudio, true)} theme={theme} onChange={checked => onConfigChange("videoGenerateAudio", String(checked))} />
                <div className="mt-2 text-xs opacity-65">RunningHub Seedance 2.0 Global Token：4–15 秒，最多 9 张图片、3 段视频和 3 段音频；本地素材自动上传。</div>
            </SettingGroup>,
        };
    }
    if (isAgnesConfig(resolveModelRequestConfig(config, videoModelValue))) {
        let ratio = config.size;
        try { ratio = agnesRatio(config.size, true); } catch { /* 提交时明确报出不支持的画幅。 */ }
        return {
            ratio, allowedRatios: AGNES_VIDEO_RATIOS, autoValue: "auto", allowsAuto: false,
            resolution: "720p", allowedResolutions: ["720p"],
            duration: resolveVideoDuration(config.videoSeconds || "5", prompt, integerDurationRange(4, 12), 5),
            durationMin: 4, durationMax: 12, durationStep: 1, durationAuto: isAutoVideoDuration(config.videoSeconds),
            extras: <div className="text-xs opacity-65">Agnes Flash：720P，4–12 秒；最多 5 张公网参考图和 3 段公网音频，不支持参考视频及本地素材上传。提示词原样发送。</div>,
        };
    }
    if (resolveModelRequestConfig(config, videoModelValue).apiFormat === "autodl") {
        const settings = autodlVideoSettings(config.size, config.vquality);
        const durationAuto = isAutoDurationValue(config.videoSeconds);
        return {
            ...settings,
            allowedRatios: ["16:9", "9:16", "1:1"], autoValue: "auto", allowsAuto: false,
            allowedResolutions: ["480p", "768p"],
            duration: durationAuto ? inferVideoDurationFromPrompt(prompt, integerDurationRange(1, 15), 5) : Math.max(1, Math.min(15, Math.floor(Number(config.videoSeconds) || 5))),
            durationMin: 1, durationMax: 15, durationStep: 1, durationAuto,
            extras: <div className="text-xs opacity-65">升级画质 H3：连接 1–9 张图片，可选 0–3 段 MP3/WAV/FLAC 音频；不支持参考视频。图片和音频分别按参考顺序传入。</div>,
        };
    }
    if (isFeimiaoModelConfig(config, videoModelValue)) {
        const modelName = modelOptionName(videoModelValue || config.videoModel || config.model);
        const spec = getFeimiaoSpec(modelName);
        const durations = spec.durations.length ? spec.durations : integerDurationRange(5, 15);
        const durationAuto = isAutoDurationValue(config.videoSeconds);
        return {
            ratio: normalizeFeimiaoAspectRatio(config.size, modelName),
            allowedRatios: spec.aspectRatios,
            autoValue: "auto",
            allowsAuto: spec.aspectRatios.includes("auto") || spec.aspectRatios.includes("adaptive"),
            resolution: normalizeFeimiaoResolution(config.vquality, modelName),
            allowedResolutions: spec.resolutions.length ? spec.resolutions : RESOLUTION_CATALOG.map((item) => item.value),
            duration: durationAuto ? inferVideoDurationFromPrompt(prompt, durations) : normalizeFeimiaoDuration(config.videoSeconds, modelName),
            ...durationSliderBounds(durations),
            durationAuto,
        };
    }

    if (isSeedanceVideoConfig(config)) {
        const generateAudio = boolConfig(config.videoGenerateAudio, true);
        const watermark = boolConfig(config.videoWatermark, false);
        const allowed = integerDurationRange(4, 15);
        const durationAuto = isAutoDurationValue(config.videoSeconds);
        const duration = durationAuto ? inferVideoDurationFromPrompt(prompt, allowed, 5) : normalizeSeedanceDuration(config.videoSeconds);
        return {
            ratio: normalizeSeedanceRatio(config.size),
            allowedRatios: ["adaptive", "auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
            autoValue: "adaptive",
            allowsAuto: true,
            resolution: normalizeSeedanceResolution(config.vquality),
            allowedResolutions: ["480p", "720p", "1080p"],
            duration: duration === -1 ? 5 : duration,
            durationMin: 4,
            durationMax: 15,
            durationStep: 1,
            durationAuto,
            extras: (
                <SettingGroup title={t("settingsPanels.video.output")} color={theme.node.muted}>
                    <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label={t("settingsPanels.video.generateAudio")} checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SwitchRow label={t("settingsPanels.video.watermark")} checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                    </div>
                </SettingGroup>
            ),
        };
    }

    const allowed = resolveModelRequestConfig(config, videoModelValue).apiFormat === "comfyui" ? integerDurationRange(1, 20) : integerDurationRange(5, 15);
    const durationAuto = isAutoDurationValue(config.videoSeconds);
    const seconds = durationAuto ? inferVideoDurationFromPrompt(prompt, allowed, 5) : Math.max(1, Math.min(20, Math.floor(Number(config.videoSeconds) || 5)));
    return {
        ratio: toCatalogRatio(config.size),
        allowedRatios: RATIO_CATALOG.map((item) => item.value),
        autoValue: "auto",
        allowsAuto: true,
        resolution: toCatalogResolution(config.vquality),
        allowedResolutions: RESOLUTION_CATALOG.map((item) => item.value),
        duration: seconds,
        durationMin: 1,
        durationMax: 20,
        durationStep: 1,
        durationAuto,
    };
}

export function videoResolutionLabel(value: string) {
    const resolution = toCatalogResolution(value);
    return RESOLUTION_CATALOG.find((item) => sameResolution(item.value, resolution))?.label || `${normalizeVideoResolutionValue(value)}P`;
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return "Auto";
    if (/^\d+:\d+$/.test(value || "")) return value;
    const size = normalizeVideoSizeValue(value);
    const option = sizeOptions.find((item) => item.value === size);
    return option ? i18n.t(`settingsPanels.video.sizes.${option.labelKey}`) : size;
}

export function videoSecondsLabel(value: string) {
    if (isAutoVideoDuration(value)) return i18n.t("settingsPanels.common.auto");
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "5"}s`;
}

export function videoSettingsSummary(config: AiConfig, prompt = "") {
    const videoModelValue = modelCapabilityOf(config, config.model) === "video" ? config.model : config.videoModel;
    if (isRunningHubConfig(resolveModelRequestConfig(config, videoModelValue))) {
        const ratio = normalizeSeedanceRatio(config.size);
        return `${normalizeSeedanceResolution(config.vquality).toUpperCase()} · ${ratio === "adaptive" ? "Auto" : ratio} · ${resolveVideoDuration(config.videoSeconds || "5", prompt, integerDurationRange(4, 15), 5)}s`;
    }
    if (isAgnesConfig(resolveModelRequestConfig(config, videoModelValue))) {
        let ratio = config.size;
        try { ratio = agnesRatio(config.size, true); } catch { /* 保留无效选项以便用户修正。 */ }
        return `720P · ${ratio} · ${resolveVideoDuration(config.videoSeconds || "5", prompt, integerDurationRange(4, 12), 5)}s`;
    }
    if (resolveModelRequestConfig(config, videoModelValue).apiFormat === "dola") {
        let ratio = config.size;
        try { ratio = dolaRatio(config.size); } catch { /* Invalid stored choices remain visible for correction. */ }
        return `DOLA · ${ratio} · ${isAutoVideoDuration(config.videoSeconds) ? "10" : config.videoSeconds || "10"}s`;
    }
    if (resolveModelRequestConfig(config, videoModelValue).apiFormat === "autodl") {
        const settings = autodlVideoSettings(config.size, config.vquality);
        const seconds = isAutoDurationValue(config.videoSeconds) ? durationSummary(config.videoSeconds, integerDurationRange(1, 15), prompt) : `${Math.max(1, Math.min(15, Math.floor(Number(config.videoSeconds) || 5)))}s`;
        return `${settings.resolution.toUpperCase()} · ${settings.ratio} · ${seconds}`;
    }
    if (isFeimiaoModelConfig(config, videoModelValue)) {
        const modelName = modelOptionName(videoModelValue || config.videoModel || config.model);
        const resolution = normalizeFeimiaoResolution(config.vquality, modelName);
        const ratio = normalizeFeimiaoAspectRatio(config.size, modelName);
        const seconds = isAutoDurationValue(config.videoSeconds)
            ? durationSummary(config.videoSeconds, getFeimiaoSpec(modelName).durations, prompt)
            : `${normalizeFeimiaoDuration(config.videoSeconds, modelName)}s`;
        return [resolutionLabel(resolution), ratio, seconds].filter(Boolean).join(" · ");
    }
    if (isSeedanceVideoConfig(config)) {
        const resolution = normalizeSeedanceResolution(config.vquality);
        const ratio = normalizeSeedanceRatio(config.size);
        const seconds = isAutoVideoDuration(config.videoSeconds)
            ? durationSummary(config.videoSeconds, integerDurationRange(4, 15), prompt, { unmatchedAuto: i18n.t("settingsPanels.video.smart") })
            : normalizeSeedanceDuration(config.videoSeconds) === -1
              ? i18n.t("settingsPanels.video.smart")
              : `${normalizeSeedanceDuration(config.videoSeconds)}s`;
        return `${resolutionLabel(resolution)} · ${ratio === "adaptive" ? "Auto" : ratio} · ${seconds}`;
    }
    const allowed = resolveModelRequestConfig(config, videoModelValue).apiFormat === "comfyui" ? integerDurationRange(1, 20) : integerDurationRange(5, 15);
    return `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.size)} · ${durationSummary(config.videoSeconds, allowed, prompt)}`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto" || value === "adaptive") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    if (value === "16:9" || value === "21:9" || value === "4:3") return "1280x720";
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "4k" || value === "2160p" || value === "2160") return "2160";
    if (value === "1080p" || value === "1080") return "1080";
    if (value === "480p" || value === "low" || value === "480") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium" || value === "720") return "720";
    return value.replace(/p$/i, "") || "720";
}

function RatioCard({
    label,
    width,
    height,
    selected,
    disabled,
    theme,
    onClick,
}: {
    label: string;
    width: number;
    height: number;
    selected: boolean;
    disabled: boolean;
    theme: CanvasTheme;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border bg-transparent text-[11px] transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
            style={{
                borderColor: selected ? theme.node.text : theme.node.stroke,
                borderWidth: selected ? 1.5 : 1,
                color: selected ? theme.node.text : theme.node.muted,
                fontWeight: selected ? 600 : 500,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            <span className="rounded-[2px] border" style={{ width, height, borderColor: selected ? theme.node.text : theme.node.muted }} />
            <span>{label}</span>
        </button>
    );
}

function ChoiceButton({ selected, disabled, theme, onClick, children }: { selected: boolean; disabled: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="h-9 cursor-pointer rounded-lg border bg-transparent text-xs transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
            style={{
                borderColor: selected ? theme.node.text : theme.node.stroke,
                borderWidth: selected ? 1.5 : 1,
                color: selected ? theme.node.text : theme.node.muted,
                fontWeight: selected ? 600 : 500,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function DurationSlider({ value, min, max, step, auto, theme, onChange, onAuto }: { value: number; min: number; max: number; step: number; auto: boolean; theme: CanvasTheme; onChange: (value: number) => void; onAuto: () => void }) {
    const { t } = useTranslation();
    const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;
    return (
        <div className="flex items-center gap-2.5">
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-white [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
                style={{
                    background: `linear-gradient(to right, ${theme.canvas.selectionStroke} ${progress}%, ${theme.node.stroke} ${progress}%)`,
                    accentColor: theme.canvas.selectionStroke,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => onChange(Number(event.target.value))}
            />
            <div className="flex h-8 min-w-10 items-center justify-center rounded-md border px-2 text-xs tabular-nums" style={{ borderColor: theme.node.stroke, color: theme.node.text, background: theme.node.fill, opacity: auto ? 0.7 : 1 }}>
                {value}
            </div>
            <span className="text-xs" style={{ color: theme.node.muted }}>
                s
            </span>
            <button
                type="button"
                className="h-8 shrink-0 cursor-pointer rounded-md border px-2 text-xs transition hover:opacity-80"
                style={{
                    borderColor: auto ? theme.node.text : theme.node.stroke,
                    borderWidth: auto ? 1.5 : 1,
                    color: auto ? theme.node.text : theme.node.muted,
                    fontWeight: auto ? 600 : 500,
                    background: theme.node.fill,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={onAuto}
            >
                {t("settingsPanels.common.auto")}
            </button>
        </div>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-[12px] font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function sameResolution(left: string, right: string) {
    return toCatalogResolution(left) === toCatalogResolution(right);
}

function toCatalogResolution(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "4k" || normalized === "2160" || normalized === "2160p") return "4k";
    if (normalized === "low") return "480p";
    if (normalized === "auto" || normalized === "high" || normalized === "medium") return "720p";
    if (!normalized.endsWith("p") && /^\d+$/.test(normalized)) return `${normalized}p`;
    return normalized || "720p";
}

function toCatalogRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "auto";
    if (/^\d+:\d+$/.test(value)) return value;
    if (value === "1280x720" || value === "1792x1024") return "16:9";
    if (value === "720x1280" || value === "1024x1792") return "9:16";
    if (value === "1024x1024") return "1:1";
    return "16:9";
}

function resolutionLabel(value: string) {
    return RESOLUTION_CATALOG.find((item) => sameResolution(item.value, value))?.label || value.toUpperCase();
}

function snapToAllowed(value: number, allowed: number[]) {
    return allowed.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), allowed[0]);
}

function isAutoDurationValue(value: string | undefined) {
    return isAutoVideoDuration(value) || String(value ?? "").trim() === "-1";
}

function durationSliderBounds(durations: number[]) {
    const durationMin = durations[0];
    const durationMax = durations[durations.length - 1];
    const consecutive = durations.length === durationMax - durationMin + 1 && durations.every((item, index) => item === durationMin + index);
    return {
        durationMin,
        durationMax,
        durationStep: 1,
        snapDurations: consecutive ? undefined : durations,
    };
}

function durationSummary(value: string, allowed: number[], prompt: string, options?: { unmatchedAuto?: string }) {
    if (!isAutoDurationValue(value)) return `${value || allowed[0] || 5}s`.replace(/^-1s$/, i18n.t("settingsPanels.video.smart"));
    if (String(value).trim() === "-1" && !isAutoVideoDuration(value)) return i18n.t("settingsPanels.video.smart");
    if (options?.unmatchedAuto && readPromptDurationSeconds(prompt) == null) return options.unmatchedAuto;
    return `${i18n.t("settingsPanels.common.auto")} · ${inferVideoDurationFromPrompt(prompt, allowed, 5)}s`;
}
