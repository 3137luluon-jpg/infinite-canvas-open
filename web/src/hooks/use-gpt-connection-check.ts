import { useCallback, useState } from "react";
import axios from "axios";

import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { resolveStoryboardPlannerModel } from "@/lib/canvas/storyboard-generation";
import { requestImageQuestion } from "@/services/api/image";
import { buildApiUrl, modelOptionLabel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export type ConnectionStatus = "idle" | "checking" | "connected" | "error" | "timeout";

type CheckResult = { status: Exclude<ConnectionStatus, "idle" | "checking">; message: string };
const TIMEOUT_MS = 30_000;

function requestError(error: unknown, timedOut: boolean): CheckResult {
    if (timedOut) return { status: "timeout", message: "连接超时（30秒）" };
    return { status: "error", message: error instanceof Error ? error.message : "连接失败" };
}

async function checkStoryboardModel(config: AiConfig): Promise<CheckResult> {
    const model = resolveStoryboardPlannerModel(config);
    if (!model) return { status: "error", message: "未配置故事板大语言模型" };
    const label = modelOptionLabel(config, model);
    const requestConfig = resolveModelRequestConfig(config, model);
    if (!requestConfig.baseUrl.trim() || !requestConfig.apiKey.trim()) return { status: "error", message: `${label} 尚未配置接口地址或 API Key` };

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, TIMEOUT_MS);
    try {
        const plannerConfig = { ...buildGenerationConfig(config, undefined, "text"), model, systemPrompt: "" };
        const answer = await requestImageQuestion(plannerConfig, [{ role: "user", content: "连接检测：请只回复 OK。" }], () => undefined, { signal: controller.signal });
        if (!answer.trim()) return { status: "error", message: "模型已连接，但没有返回内容" };
        return { status: "connected", message: `${label} 响应正常` };
    } catch (error) {
        return requestError(error, timedOut);
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function checkStoryboardImageModel(config: AiConfig): Promise<CheckResult> {
    const model = config.storyboardImageModel || config.imageModel;
    if (!model) return { status: "error", message: "未配置故事板生图模型" };
    const label = modelOptionLabel(config, model);
    const requestConfig = resolveModelRequestConfig(config, model);
    if (!requestConfig.baseUrl.trim() || !requestConfig.apiKey.trim()) return { status: "error", message: `${label} 尚未配置接口地址或 API Key` };
    if (!requestConfig.baseUrl.toLowerCase().includes("apimart")) return { status: "connected", message: `${label} 配置完整；为避免计费未提交生图检测` };

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, TIMEOUT_MS);
    try {
        const response = await axios.get<{ success?: boolean; message?: string; remain_balance?: number; unlimited_quota?: boolean }>(buildApiUrl(requestConfig.baseUrl, "/balance"), {
            headers: { Authorization: `Bearer ${requestConfig.apiKey}` },
            signal: controller.signal,
        });
        if (response.data?.success === false) return { status: "error", message: response.data.message || "只读检测失败" };
        const balance = response.data?.unlimited_quota ? "无限额度" : typeof response.data?.remain_balance === "number" ? `余额 ${response.data.remain_balance}` : "鉴权正常";
        return { status: "connected", message: `${label} ${balance}` };
    } catch (error) {
        return requestError(error, timedOut);
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export function useGptConnectionCheck() {
    const [gptStatus, setGptStatus] = useState<ConnectionStatus>("idle");
    const [gptMessage, setGptMessage] = useState("");
    const [imageStatus, setImageStatus] = useState<ConnectionStatus>("idle");
    const [imageMessage, setImageMessage] = useState("");

    const checkConnection = useCallback(async (config: AiConfig) => {
        setGptStatus("checking");
        setGptMessage("正在调用所选故事板大模型...");
        setImageStatus("checking");
        setImageMessage("正在检查所选故事板生图模型...");
        const [gptResult, imageResult] = await Promise.all([checkStoryboardModel(config), checkStoryboardImageModel(config)]);
        setGptStatus(gptResult.status);
        setGptMessage(gptResult.message);
        setImageStatus(imageResult.status);
        setImageMessage(imageResult.message);
    }, []);

    return { gptStatus, gptMessage, imageStatus, imageMessage, checkConnection };
}
