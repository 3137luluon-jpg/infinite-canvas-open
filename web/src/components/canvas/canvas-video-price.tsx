import { useEffect, useState, useSyncExternalStore } from "react";
import { Tooltip } from "antd";
import { ensureFmgoPricing, fetchFmgoPricing, fmgoModelPrice, getFmgoPriceSnapshot, isFmgoPricingChannel, subscribeFmgoPrices } from "@/services/api/fmgo-pricing";

/** Display-only quote; never participates in a generation request. */
export function CanvasVideoPrice({ baseUrl, model, color }: { baseUrl: string; model: string; color: string }) {
    const { pricing, group } = useSyncExternalStore(subscribeFmgoPrices, getFmgoPriceSnapshot);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const enabled = isFmgoPricingChannel(baseUrl);
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        setLoading(true);
        setError("");
        void ensureFmgoPricing().catch(error => { if (active) setError(error instanceof Error ? error.message : "价格读取失败"); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [enabled, model]);
    if (!enabled) return null;
    const quote = pricing ? fmgoModelPrice(pricing, model, group) : "";
    const hasPrice = quote.endsWith("/ 次");
    const label = hasPrice ? quote : loading ? "价格读取中" : "暂无报价";
    const refresh = async () => {
        setLoading(true);
        setError("");
        try { await fetchFmgoPricing(); }
        catch (error) { setError(error instanceof Error ? error.message : "刷新价格失败"); }
        finally { setLoading(false); }
    };
    return <Tooltip title={<div>
        <div>{model} · {pricing?.groups?.[group] || group}</div>
        <div>{hasPrice ? "FMGO 公开报价，实际扣费以平台为准。" : quote || error || "正在读取 FMGO 公开价格"}</div>
        {pricing ? <div>{new Date(pricing.fetchedAt).toLocaleString("zh-CN")} 更新</div> : null}
        {error && pricing ? <div>刷新失败，当前显示上次报价：{error}</div> : null}
        <div>点击刷新价格；账户分组在渠道配置页选择。</div>
    </div>}>
        <button type="button" aria-label={`视频价格：${label}，点击刷新`} disabled={loading} onClick={() => void refresh()} className="shrink-0 whitespace-nowrap px-1 text-sm font-semibold tabular-nums disabled:opacity-60" style={{ color }}>{label}{error && pricing ? " *" : ""}</button>
    </Tooltip>;
}
