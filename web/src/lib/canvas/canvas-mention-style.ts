/** 画布 @ 资产芯片：同资产同色、名字截断 */

export type CanvasMentionTone = {
    border: string;
    background: string;
    text: string;
};

/** 高对比色，深色背景下也能一眼区分 */
const MENTION_TONES: CanvasMentionTone[] = [
    { border: "#facc15", background: "rgba(250, 204, 21, 0.28)", text: "#fde047" },
    { border: "#4ade80", background: "rgba(74, 222, 128, 0.28)", text: "#86efac" },
    { border: "#38bdf8", background: "rgba(56, 189, 248, 0.28)", text: "#7dd3fc" },
    { border: "#c084fc", background: "rgba(192, 132, 252, 0.28)", text: "#d8b4fe" },
    { border: "#fb7185", background: "rgba(251, 113, 133, 0.28)", text: "#fda4af" },
    { border: "#fb923c", background: "rgba(251, 146, 60, 0.28)", text: "#fdba74" },
    { border: "#2dd4bf", background: "rgba(45, 212, 191, 0.28)", text: "#5eead4" },
    { border: "#e879f9", background: "rgba(232, 121, 249, 0.28)", text: "#f0abfc" },
];

/** 正文芯片名字最长显示字数（超出用 …） */
export const CANVAS_MENTION_NAME_MAX = 10;

export function canvasMentionKey(reference: { nodeId?: string; label: string; id?: string }) {
    return reference.nodeId || reference.id || reference.label;
}

/** 按资产出现顺序分配颜色，保证不同资产颜色不同、同资产恒定 */
export function buildCanvasMentionToneMap(references: Array<{ nodeId?: string; label: string; id?: string }>) {
    const map = new Map<string, CanvasMentionTone>();
    for (const reference of references) {
        const key = canvasMentionKey(reference);
        if (!key || map.has(key)) continue;
        map.set(key, MENTION_TONES[map.size % MENTION_TONES.length]);
    }
    return map;
}

export function canvasMentionTone(key: string, toneMap?: Map<string, CanvasMentionTone>): CanvasMentionTone {
    if (toneMap?.has(key)) return toneMap.get(key)!;
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return MENTION_TONES[hash % MENTION_TONES.length];
}

export function truncateCanvasMentionName(name: string, max = CANVAS_MENTION_NAME_MAX) {
    const text = name.trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
}

export function canvasMentionDisplayName(reference: { title?: string; label: string; kind: string; text?: string }) {
    if (reference.kind === "text") return truncateCanvasMentionName(reference.text || reference.title || reference.label);
    return truncateCanvasMentionName(reference.title || reference.label);
}

export function mentionedReferenceLabels(prompt: string, labels: string[]) {
    const mentioned = new Set<string>();
    for (const label of labels) {
        if (label && prompt.includes(label)) mentioned.add(label);
    }
    return mentioned;
}

export function hasCanvasReferenceMention(prompt: string, reference: { nodeId: string; label: string }) {
    return prompt.includes(`@[node:${reference.nodeId}]`) || Boolean(reference.label && prompt.includes(reference.label));
}

/** 断开连线时从提示词中彻底移除该引用标签，不留下「图片N」原文 */
export function stripReferenceLabelFromPrompt(prompt: string, label: string) {
    if (!label || !prompt.includes(label)) return prompt;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return prompt
        .replace(new RegExp(`${escaped} ?`, "g"), "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n");
}

/** 同时清理新式稳定节点引用与旧式位置标签，避免断线后留下失效 @ 芯片。 */
export function stripCanvasReferenceFromPrompt(prompt: string, reference: { nodeId: string; label: string }) {
    const token = `@[node:${reference.nodeId}]`;
    return stripReferenceLabelFromPrompt(prompt.replaceAll(token, ""), reference.label)
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n");
}
