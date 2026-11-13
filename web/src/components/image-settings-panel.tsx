import { type ReactNode } from "react";
import { ConfigProvider } from "antd";
import { useTranslation } from "react-i18next";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { normalizeImageAspect, normalizeImageResolution } from "@/lib/apimart-image";
import { buildOfficialImageFields, isOfficialOpenAiImageUrl } from "@/lib/openai-image";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { AGNES_IMAGE_RATIOS, agnesRatio, isAgnesConfig } from "@/lib/agnes";

/** APIMart gpt-image-2：分辨率档位 */
const resolutionOptions = [
    { value: "1k", label: "1k" },
    { value: "2k", label: "2k" },
    { value: "4k", label: "4k" },
] as const;

/** APIMart gpt-image-2：宽高比（size 字段） */
const aspectOptions = [
    { value: "auto", label: "auto" },
    { value: "1:1", label: "1:1" },
    { value: "1:3", label: "1:3" },
    { value: "3:1", label: "3:1" },
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "5:4", label: "5:4" },
    { value: "4:5", label: "4:5" },
    { value: "2:1", label: "2:1" },
    { value: "1:2", label: "1:2" },
    { value: "21:9", label: "21:9" },
    { value: "9:21", label: "9:21" },
] as const;

export const imageAspectOptions = aspectOptions.map((item) => ({ value: item.value, label: item.label }));
export const imageQualityOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "background" | "count", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    showCount?: boolean;
    className?: string;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, showCount = false, className = "w-[260px] space-y-2.5 rounded-xl px-0.5 py-0.5" }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const resolution = normalizeImageResolution(config.quality);
    const official = isOfficialOpenAiImageUrl(resolveModelRequestConfig(config, config.model || config.imageModel).baseUrl);
    const agnes = isAgnesConfig(resolveModelRequestConfig(config, config.model || config.imageModel));
    let activeSize = normalizeImageAspect(config.size);
    if (agnes) { try { activeSize = agnesRatio(config.size); } catch { /* 提交时提示不支持的比例。 */ } }
    let officialPixels = "";
    if (official) {
        try { officialPixels = buildOfficialImageFields({ model: resolveModelRequestConfig(config, config.model || config.imageModel).model, prompt: "", n: 1, size: config.size, quality: config.quality }).size; } catch { /* Invalid stored values are reported at submission. */ }
    }
    const activeCount = String(Math.max(1, Math.min(4, Math.floor(Number(config.count) || 1))));

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-sm font-semibold">{t("settingsPanels.image.title")}</div> : null}
                {official ? <div className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>当前请求尺寸：{officialPixels || "待重新选择"}。官方4K档按最多8294400像素换算，保留所选比例，边长不超过3840；不会自动降为低清。auto尺寸由接口决定。修改设置后请点击发送；重试沿用原参数。</div> : null}
                <div className="space-y-1.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    <div className="grid grid-cols-3 gap-1.5">
                        {resolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-1.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-1">
                        {aspectOptions.filter(item => !agnes || AGNES_IMAGE_RATIOS.includes(item.value)).map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="h-6 cursor-pointer bg-transparent text-xs transition hover:opacity-80"
                                style={{ color: activeSize === item.value ? theme.node.text : theme.node.muted, fontWeight: activeSize === item.value ? 600 : 400 }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                </div>
                {showCount ? (
                    <div className="space-y-1.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                        <div className="grid grid-cols-4 gap-1.5">
                            {["1", "2", "3", "4"].map((count) => (
                                <OptionPill key={count} selected={activeCount === count} theme={theme} onClick={() => onConfigChange("count", count)}>
                                    {t("settingsPanels.image.images", { count })}
                                </OptionPill>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return normalizeImageResolution(value);
}

export function imageSizeLabel(size: string) {
    return normalizeImageAspect(size);
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-7 cursor-pointer rounded-full border px-1.5 text-xs transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}
