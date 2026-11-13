import type { CanvasNodeData } from "@/types/canvas";

export type CinePackCharacterReference = {
    id: string;
    name: string;
    dataUrl: string;
    storageKey?: string;
    variantId?: string;
    available: boolean;
};

export const CINEPACK_BASE_CHARACTER_REFERENCE_ID = "base";

export function cinePackCharacterReferences(node: CanvasNodeData): CinePackCharacterReference[] {
    const cinepack = node.metadata?.cinepack;
    if (cinepack?.kind !== "asset" || cinepack.assetType !== "character") return [];
    return [
        {
            id: CINEPACK_BASE_CHARACTER_REFERENCE_ID,
            name: "基础设定",
            dataUrl: node.metadata?.content || "",
            storageKey: node.metadata?.storageKey,
            available: Boolean(node.metadata?.content || node.metadata?.storageKey),
        },
        ...(cinepack.characterLooks || []).map((look) => ({
            id: look.variantId,
            variantId: look.variantId,
            name: look.name,
            dataUrl: "",
            storageKey: look.selectedReference?.storageKey,
            available: Boolean(look.selectedReference?.storageKey),
        })),
    ];
}

export function cinePackBoundCharacterReference(shotNode: CanvasNodeData | undefined, assetNode: CanvasNodeData): CinePackCharacterReference | undefined {
    const assetId = assetNode.metadata?.cinepack?.assetId;
    const variantId = assetId ? shotNode?.metadata?.cinepack?.variantBindings?.[assetId] : undefined;
    const references = cinePackCharacterReferences(assetNode);
    if (variantId) return references.find((reference) => reference.id === variantId);
    const availableLooks = references.filter((reference) => reference.variantId && reference.available);
    return availableLooks.length === 1 ? availableLooks[0] : undefined;
}

export function selectCinePackCharacterReference(shotNode: CanvasNodeData, assetNode: CanvasNodeData, referenceId: string): CanvasNodeData {
    const assetId = assetNode.metadata?.cinepack?.assetId;
    if (!assetId || assetNode.metadata?.cinepack?.assetType !== "character") throw new Error("当前节点不是 CinePack 角色资产");
    if (shotNode.metadata?.cinepack?.kind !== "shot") throw new Error("当前节点不是 CinePack 镜头");
    if (!cinePackCharacterReferences(assetNode).some((reference) => reference.id === referenceId)) throw new Error("所选角色造型不存在");
    return {
        ...shotNode,
        metadata: {
            ...shotNode.metadata,
            cinepack: {
                ...shotNode.metadata.cinepack,
                variantBindings: {
                    ...shotNode.metadata.cinepack.variantBindings,
                    [assetId]: referenceId,
                },
            },
        },
    };
}
