export type FmgoPricing = {
    models: { model_name: string; quota_type: number; model_price: number; enable_groups?: string[] }[];
    groupRatios: Record<string, number>;
    groups: Record<string, string>;
    currency: { type: string; symbol: string; customRate: number; usdRate: number };
    fetchedAt: number;
};

let priceSnapshot: { pricing: FmgoPricing | null; group: string } = { pricing: null, group: "default" };
const priceListeners = new Set<() => void>();
export const getFmgoPriceSnapshot = () => priceSnapshot;
export const subscribeFmgoPrices = (listener: () => void) => { priceListeners.add(listener); return () => { priceListeners.delete(listener); }; };
export function setFmgoPriceGroup(group: string) {
    priceSnapshot = { ...priceSnapshot, group };
    priceListeners.forEach(listener => listener());
}
let pendingPrices: Promise<FmgoPricing> | null = null;
export function ensureFmgoPricing() {
    if (priceSnapshot.pricing && Date.now() - priceSnapshot.pricing.fetchedAt < 5 * 60_000) return Promise.resolve(priceSnapshot.pricing);
    if (!pendingPrices) pendingPrices = fetchFmgoPricing().finally(() => { pendingPrices = null; });
    return pendingPrices;
}

export function isFmgoPricingChannel(baseUrl: string) {
    try { return ["fmgo.top", "www.fmgo.top", "api.fmgo.top"].includes(new URL(baseUrl).hostname.toLowerCase()); }
    catch { return false; }
}

export async function fetchFmgoPricing(signal?: AbortSignal): Promise<FmgoPricing> {
    const response = await fetch("/__fmgo-pricing", { signal, cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.models)) throw new Error(data.error || "刷新价格失败，请确认本地服务已更新");
    priceSnapshot = { ...priceSnapshot, pricing: data };
    priceListeners.forEach(listener => listener());
    return data;
}

export function fmgoModelPrice(pricing: FmgoPricing, name: string, group: string) {
    const model = pricing.models.find(model => model.model_name === name);
    if (!model) return "官网未找到该模型报价";
    const ratio = pricing.groupRatios?.[group];
    if (!Number.isFinite(ratio) || (model.enable_groups && !model.enable_groups.includes(group))) return "该分组未提供报价";
    if (model.quota_type !== 1) return "按用量计费 · 查看官网";
    const currency = pricing.currency;
    const rate = currency.type === "CNY" ? currency.usdRate : currency.type === "CUSTOM" ? currency.customRate : 1;
    if (!Number.isFinite(model.model_price) || !Number.isFinite(rate) || rate <= 0) return "官网价格格式暂不支持";
    const symbol = currency.type === "CNY" ? "¥" : currency.type === "CUSTOM" ? currency.symbol || "额度 " : "$";
    const value = model.model_price * ratio * rate;
    return `${symbol}${value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} / 次`;
}
