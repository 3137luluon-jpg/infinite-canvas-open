import { readZip } from "@/lib/zip";
import { buildCinePackVideoPrompt } from "@/lib/canvas/cinepack-video-prompt";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { CINEPACK_V1_SCHEMA_VERSION, type CinePackAsset, type CinePackAssetType, type CinePackDocument, type CinePackManifest, type CinePackMedia, type CinePackShot, type CinePackStoryboard } from "@/types/cinepack";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const ASSET_LABEL: Record<CinePackAssetType, string> = { character: "角色", scene: "场景", prop: "物品" };

export type CinePackArchive = {
    manifest: CinePackManifest;
    document: CinePackDocument;
    files: Map<string, Blob>;
    media: CinePackMedia[];
};

export type CinePackMediaBinding = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type CinePackBuildResult = {
    project: Partial<CanvasProject>;
    counts: { shots: number; shotGroups: number; assets: number; storyboards: number; media: number };
    nodeIds: { assets: Record<string, string>; shots: Record<string, string>; shotGroups: Record<string, string> };
};

export class CinePackValidationError extends Error {
    constructor(message: string) {
        super(`CinePack 校验失败：${message}`);
        this.name = "CinePackValidationError";
    }
}

export async function readCinePackV1(file: Blob): Promise<CinePackArchive> {
    if (!file.size) fail("文件为空");
    if (file.size > MAX_ARCHIVE_BYTES) fail("压缩包超过 512MB 上限");
    let files: Map<string, Blob>;
    try {
        files = await readZip(file);
    } catch {
        fail("不是有效的 ZIP 容器");
    }
    const totalBytes = Array.from(files.values()).reduce((sum, item) => sum + item.size, 0);
    if (totalBytes > MAX_UNPACKED_BYTES) fail("解包内容超过 1GB 上限");
    for (const path of files.keys()) validateArchivePath(path);

    const manifest = (await readJson(files, "manifest.json")) as CinePackManifest;
    const document = (await readJson(files, "cinepack.json")) as CinePackDocument;
    const schema = await readJson(files, "schema/cinepack-v1.schema.json");
    if (!isObject(schema) || schema.title !== "CinePack V1") fail("内嵌 schema 不是 CinePack V1");

    validateManifest(manifest, "manifest.json");
    validateDocument(document);
    if (canonicalJson(manifest) !== canonicalJson(document.manifest)) fail("manifest.json 与 cinepack.json.manifest 不一致");

    const media = collectMedia(document);
    await validateMedia(files, media);
    return { manifest, document, files, media };
}

export function buildCinePackCanvasProject(archive: CinePackArchive, bindings: Map<string, CinePackMediaBinding>): CinePackBuildResult {
    const { document, manifest } = archive;
    for (const media of archive.media) if (!bindings.has(media.path)) fail(`媒体尚未写入本地存储：${media.path}`);

    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const connectionKeys = new Set<string>();
    const assetNodeIds: Record<string, string> = {};
    const shotNodeIds: Record<string, string> = {};
    const shotGroupNodeIds: Record<string, string> = {};
    const meta = (kind: NonNullable<CanvasNodeMetadata["cinepack"]>["kind"], stableId: string, extra: Partial<NonNullable<CanvasNodeMetadata["cinepack"]>> = {}) =>
        ({
            schemaVersion: CINEPACK_V1_SCHEMA_VERSION,
            projectId: manifest.projectId,
            revisionId: manifest.revisionId,
            kind,
            stableId,
            ...extra,
        }) satisfies NonNullable<CanvasNodeMetadata["cinepack"]>;
    const addConnection = (fromNodeId: string, toNodeId: string) => {
        const key = `${fromNodeId}->${toNodeId}`;
        if (connectionKeys.has(key)) return;
        connectionKeys.add(key);
        connections.push({ id: nodeId(manifest.projectId, "connection", key), fromNodeId, toNodeId });
    };

    const overviewGroupId = nodeId(manifest.projectId, "group", "overview");
    nodes.push(groupNode(overviewGroupId, "片场流项目资料", 0, 0, 1120, 650, meta("project", manifest.projectId, { locked: true })));
    const overviewItems = [
        {
            id: "project",
            title: `项目 · ${document.project.name}`,
            content: projectSummary(document),
            kind: "project" as const,
        },
        { id: "story", title: "已确认故事", content: document.content.story.text, kind: "content" as const },
        { id: "script", title: "已确认剧本", content: document.content.script.text, kind: "content" as const },
        { id: "shotlist", title: "已确认导演分镜", content: document.content.shotlist.text, kind: "content" as const },
        { id: "visual-style", title: "视觉风格", content: visualStyleSummary(document), kind: "visual-style" as const },
    ];
    overviewItems.forEach((item, index) => {
        const columns = 3;
        nodes.push(textNode(nodeId(manifest.projectId, item.kind, item.id), item.title, 30 + (index % columns) * 360, 80 + Math.floor(index / columns) * 270, item.content, overviewGroupId, meta(item.kind, item.id, { locked: true })));
    });

    const assetGroupId = nodeId(manifest.projectId, "group", "assets");
    const assetColumns = Math.min(4, Math.max(1, document.assets.length));
    const assetRows = Math.ceil(document.assets.length / assetColumns);
    const assetTop = 710;
    nodes.push(groupNode(assetGroupId, "片场流参考资产", 0, assetTop, 40 + assetColumns * 360, 100 + assetRows * 270, meta("asset-group", "assets", { locked: true })));
    const sortedAssets = [...document.assets].sort((left, right) => `${left.type}:${left.name}:${left.assetId}`.localeCompare(`${right.type}:${right.name}:${right.assetId}`, "zh-CN"));
    sortedAssets.forEach((asset, index) => {
        const id = nodeId(manifest.projectId, "asset", asset.assetId);
        assetNodeIds[asset.assetId] = id;
        const binding = asset.selectedReference ? bindings.get(asset.selectedReference.path) : undefined;
        const identityBinding = asset.identityReference ? bindings.get(asset.identityReference.path) : undefined;
        const characterLooks = asset.type === "character" ? asset.variants.map((variant) => {
            const referenceBinding = variant.selectedReference ? bindings.get(variant.selectedReference.path) : undefined;
            return {
                variantId: variant.id,
                name: variant.name,
                promptZh: typeof variant.promptZh === "string" ? variant.promptZh : "",
                explicitFacts: isObject(variant.explicitFacts) ? variant.explicitFacts : {},
                inferredFacts: isObject(variant.inferredFacts) ? variant.inferredFacts : {},
                sourceRefs: Array.isArray(variant.sourceRefs) ? variant.sourceRefs.filter(isObject) : [],
                ...(variant.selectedReference ? { selectedReference: { versionId: variant.selectedReference.versionId || variant.selectedReference.id, sourcePath: variant.selectedReference.path, storageKey: referenceBinding?.storageKey } } : {}),
            };
        }) : undefined;
        nodes.push(
            imageNode(
                id,
                `${ASSET_LABEL[asset.type]} · ${asset.name}`,
                30 + (index % assetColumns) * 360,
                assetTop + 80 + Math.floor(index / assetColumns) * 270,
                binding,
                asset.promptZh,
                assetGroupId,
                meta("asset", asset.assetId, {
                    assetId: asset.assetId,
                    assetType: asset.type,
                    sourcePath: asset.selectedReference?.path,
                    ...(asset.identityReference ? { identityReference: { versionId: asset.identityReference.versionId || asset.identityReference.id, sourcePath: asset.identityReference.path, storageKey: identityBinding?.storageKey } } : {}),
                    ...(characterLooks ? { characterLooks } : {}),
                    locked: true,
                    lockedFacts: asset.lockedFacts,
                    continuityRules: asset.continuityRules,
                    explicitFacts: asset.explicitFacts,
                    inferredFacts: asset.inferredFacts,
                }),
            ),
        );
    });

    const shotsByGroup = new Map<string, CinePackShot[]>();
    [...document.shots]
        .sort((left, right) => left.number - right.number || left.shotId.localeCompare(right.shotId))
        .forEach((shot) => {
            shotsByGroup.set(shot.shotGroupId, [...(shotsByGroup.get(shot.shotGroupId) || []), shot]);
        });
    const storyboardByShot = new Map(document.storyboards.map((item) => [item.shotId, item]));
    let groupTop = assetTop + 140 + assetRows * 270;
    for (const [shotGroupId, shots] of shotsByGroup) {
        const groupId = nodeId(manifest.projectId, "group", shotGroupId);
        shotGroupNodeIds[shotGroupId] = groupId;
        const height = 120 + shots.length * 300;
        nodes.push(groupNode(groupId, `场次 / 镜头组 · ${shotGroupId}`, 0, groupTop, 1120, height, meta("shot-group", shotGroupId, { shotGroupId, locked: true })));
        shots.forEach((shot, rowIndex) => {
            const storyboard = storyboardByShot.get(shot.shotId);
            const y = groupTop + 80 + rowIndex * 300;
            const common = { shotId: shot.shotId, shotGroupId: shot.shotGroupId, sceneId: shot.sceneId, assetRefIds: allAssetRefIds(shot), variantBindings: shot.assetRefs.variantBindings || {}, locked: true };
            const promptId = nodeId(manifest.projectId, "prompt", shot.shotId);
            const storyboardId = nodeId(manifest.projectId, "storyboard", shot.shotId);
            const shotId = nodeId(manifest.projectId, "shot", shot.shotId);
            shotNodeIds[shot.shotId] = shotId;
            nodes.push(textNode(promptId, `镜头 ${shot.number} Prompt`, 30, y, shotPromptSummary(shot, storyboard), groupId, meta("prompt", shot.shotId, common)));
            if (storyboard) {
                nodes.push(
                    imageNode(storyboardId, `镜头 ${shot.number} · 已选故事板`, 390, y, bindings.get(storyboard.selectedImage.path), storyboard.prompt, groupId, meta("storyboard", shot.shotId, { ...common, sourcePath: storyboard.selectedImage.path })),
                );
            }
            nodes.push(
                videoNode(
                    shotId,
                    `镜头 ${shot.number} · ${shot.title}`,
                    750,
                    y,
                    buildCinePackVideoPrompt(shot, document, { storyboardNodeId: storyboard ? storyboardId : undefined, assetNodeIds }),
                    document.project.aspect,
                    shot.duration,
                    groupId,
                    meta("shot", shot.shotId, common),
                ),
            );

            // 镜头说明文本只留在画布供阅读，不连入视频节点：生成只用 @ 故事板/资产图，连上会误进参考条。
            if (storyboard) addConnection(storyboardId, shotId);
            for (const assetId of allAssetRefIds(shot)) {
                const assetNodeId = assetNodeIds[assetId];
                if (assetNodeId) addConnection(assetNodeId, shotId);
            }
        });
        groupTop += height + 60;
    }

    return {
        project: {
            title: manifest.projectName,
            createdAt: document.project.createdAt,
            nodes,
            connections,
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: true,
            viewport: { x: 80, y: 60, k: 0.65 },
        },
        counts: { shots: document.shots.length, shotGroups: shotsByGroup.size, assets: document.assets.length, storyboards: document.storyboards.length, media: archive.media.length },
        nodeIds: { assets: assetNodeIds, shots: shotNodeIds, shotGroups: shotGroupNodeIds },
    };
}

async function validateMedia(files: Map<string, Blob>, media: CinePackMedia[]) {
    const paths = new Set<string>();
    const ids = new Set<string>();
    for (const item of media) {
        validateMediaDescriptor(item);
        if (paths.has(item.path)) fail(`媒体路径重复：${item.path}`);
        if (ids.has(item.id)) fail(`媒体 ID 重复：${item.id}`);
        paths.add(item.path);
        ids.add(item.id);
        const blob = files.get(item.path);
        if (!blob) fail(`缺少媒体：${item.path}`);
        if (blob.size !== item.bytes) fail(`媒体字节数不匹配：${item.path}`);
        const typedBlob = blob.slice(0, blob.size, item.mimeType);
        if (!(await matchesMimeSignature(typedBlob, item.mimeType))) fail(`媒体格式与 MIME 不一致：${item.path}`);
        const hash = await sha256(typedBlob);
        if (hash !== item.sha256) fail(`媒体 SHA-256 不匹配：${item.path}`);
    }
}

function validateDocument(value: unknown): asserts value is CinePackDocument {
    const doc = objectAt(value, "cinepack.json");
    validateManifest(doc.manifest, "cinepack.json.manifest");
    const project = objectAt(doc.project, "project");
    stringAt(project.projectId, "project.projectId");
    stringAt(project.name, "project.name");
    if (project.projectId !== (doc.manifest as CinePackManifest).projectId) fail("project.projectId 与 manifest.projectId 不一致");
    if (project.name !== (doc.manifest as CinePackManifest).projectName) fail("project.name 与 manifest.projectName 不一致");
    ["type", "duration", "aspect", "medium", "tone", "language", "createdAt", "updatedAt"].forEach((key) => stringValueAt(project, key, `project.${key}`, key === "createdAt"));

    const content = objectAt(doc.content, "content");
    (["story", "script", "shotlist"] as const).forEach((key) => {
        const item = objectAt(content[key], `content.${key}`);
        if (key === "story") {
            if (!["confirmed", "unconfirmed"].includes(item.status as string)) fail(`content.${key}.status 不合法`);
            if (item.status === "confirmed") stringAt(item.text, `content.${key}.text`);
            else {
                stringValueAt(item, "text", `content.${key}.text`);
                if ((item.text as string).trim()) fail("content.story 未确认时必须为空；存在真实故事内容时必须 confirmed");
            }
        } else {
            if (item.status !== "confirmed") fail(`content.${key}.status 必须为 confirmed`);
            stringAt(item.text, `content.${key}.text`);
        }
        stringValueAt(item, "revisionNotes", `content.${key}.revisionNotes`);
        stringValueAt(item, "updatedAt", `content.${key}.updatedAt`);
    });
    const style = objectAt(doc.visualStyle, "visualStyle");
    ["medium", "period", "location"].forEach((key) => stringValueAt(style, key, `visualStyle.${key}`));
    ["palette", "lightingRules", "cameraRules", "textureRules", "negativeRules"].forEach((key) => stringArrayAt(style[key], `visualStyle.${key}`));

    const assets = arrayAt(doc.assets, "assets", true) as unknown as CinePackAsset[];
    const assetIds = uniqueIds(assets, "assetId", "assets");
    const assetById = new Map<string, CinePackAsset>();
    assets.forEach((asset, index) => {
        validateAsset(asset, `assets[${index}]`);
        assetById.set(asset.assetId, asset);
    });
    assets.forEach((asset, index) =>
        asset.ownerAssetIds.forEach((id) => {
            if (!assetById.has(id)) fail(`assets[${index}].ownerAssetIds 引用了不存在的资产：${id}`);
        }),
    );
    const shots = arrayAt(doc.shots, "shots", true) as unknown as CinePackShot[];
    uniqueIds(shots, "shotId", "shots");
    const shotById = new Map<string, CinePackShot>();
    shots.forEach((shot, index) => {
        validateShot(shot, `shots[${index}]`, assetById);
        shotById.set(shot.shotId, shot);
    });
    const storyboards = arrayAt(doc.storyboards, "storyboards") as unknown as CinePackStoryboard[];
    uniqueIds(storyboards, "shotId", "storyboards");
    storyboards.forEach((storyboard, index) => validateStoryboard(storyboard, `storyboards[${index}]`, shotById, assetById));
    void assetIds;
}

function validateManifest(value: unknown, path: string): asserts value is CinePackManifest {
    const item = objectAt(value, path);
    if (item.schemaVersion !== CINEPACK_V1_SCHEMA_VERSION) fail(`${path}.schemaVersion 仅支持 ${CINEPACK_V1_SCHEMA_VERSION}`);
    ["projectId", "revisionId", "projectName", "exportedAt"].forEach((key) => stringValueAt(item, key, `${path}.${key}`, true));
    if (Number.isNaN(Date.parse(item.exportedAt as string))) fail(`${path}.exportedAt 必须是有效日期时间`);
    const source = objectAt(item.sourceApp, `${path}.sourceApp`);
    if (source.name !== "片场流 Lite") fail(`${path}.sourceApp.name 必须为片场流 Lite`);
    stringValueAt(source, "version", `${path}.sourceApp.version`, true);
}

function validateAsset(value: unknown, path: string): asserts value is CinePackAsset {
    const item = objectAt(value, path);
    stringAt(item.assetId, `${path}.assetId`);
    if (!(["character", "scene", "prop"] as unknown[]).includes(item.type)) fail(`${path}.type 不受支持`);
    stringAt(item.name, `${path}.name`);
    if (!(["required", "recommended", "optional"] as unknown[]).includes(item.importance)) fail(`${path}.importance 不合法`);
    ["aliases", "unknownFields", "ownerAssetIds", "lockedFacts", "visualRules", "continuityRules", "negativeRules"].forEach((key) => stringArrayAt(item[key], `${path}.${key}`));
    ["explicitFacts", "inferredFacts"].forEach((key) => objectAt(item[key], `${path}.${key}`));
    arrayAt(item.sourceRefs, `${path}.sourceRefs`, true).forEach((source, index) => {
        const sourcePath = `${path}.sourceRefs[${index}]`;
        const ref = objectAt(source, sourcePath);
        if (!(["story", "script", "shotlist", "existing_registry"] as unknown[]).includes(ref.stage)) fail(`${sourcePath}.stage 不合法`);
        stringAt(ref.groupId, `${sourcePath}.groupId`);
        stringAt(ref.evidence, `${sourcePath}.evidence`);
    });
    const variantIds = new Set<string>();
    arrayAt(item.variants, `${path}.variants`).forEach((variant, index) => {
        const variantPath = `${path}.variants[${index}]`;
        const object = objectAt(variant, variantPath);
        const variantId = stringAt(object.id, `${variantPath}.id`);
        if (variantIds.has(variantId)) fail(`${path}.variants.id 重复：${variantId}`);
        variantIds.add(variantId);
        stringAt(object.name, `${variantPath}.name`);
        if (object.selectedReference !== null) validateMediaDescriptor(object.selectedReference, `${variantPath}.selectedReference`, "media/assets/");
    });
    stringValueAt(item, "promptZh", `${path}.promptZh`);
    stringValueAt(item, "negativePromptZh", `${path}.negativePromptZh`);
    if (item.identityReference !== undefined && item.identityReference !== null) validateMediaDescriptor(item.identityReference, `${path}.identityReference`, "media/assets/");
    if (item.selectedReference !== null) validateMediaDescriptor(item.selectedReference, `${path}.selectedReference`, "media/assets/");
}

function validateShot(value: unknown, path: string, assets: Map<string, CinePackAsset>): asserts value is CinePackShot {
    const item = objectAt(value, path);
    ["shotId", "shotGroupId", "sceneId", "title"].forEach((key) => stringValueAt(item, key, `${path}.${key}`, true));
    ["duration", "story", "notes"].forEach((key) => stringValueAt(item, key, `${path}.${key}`));
    if (!Number.isInteger(item.number) || (item.number as number) < 1) fail(`${path}.number 必须为正整数`);
    const refs = objectAt(item.assetRefs, `${path}.assetRefs`);
    const typedRefs = { characterIds: stringArrayAt(refs.characterIds, `${path}.assetRefs.characterIds`), sceneIds: stringArrayAt(refs.sceneIds, `${path}.assetRefs.sceneIds`), propIds: stringArrayAt(refs.propIds, `${path}.assetRefs.propIds`) };
    const expectedTypes: Record<keyof typeof typedRefs, CinePackAssetType> = { characterIds: "character", sceneIds: "scene", propIds: "prop" };
    for (const [key, ids] of Object.entries(typedRefs) as Array<[keyof typeof typedRefs, string[]]>) {
        ids.forEach((id) => {
            const asset = assets.get(id);
            if (!asset) fail(`${path}.assetRefs 引用了不存在的资产：${id}`);
            if (asset.type !== expectedTypes[key]) fail(`${path}.assetRefs.${key} 的资产类型不匹配：${id}`);
        });
    }
    if (refs.variantBindings !== undefined) {
        const bindings = objectAt(refs.variantBindings, `${path}.assetRefs.variantBindings`);
        for (const [assetId, rawVariantId] of Object.entries(bindings)) {
            const asset = assets.get(assetId);
            const variantId = stringAt(rawVariantId, `${path}.assetRefs.variantBindings.${assetId}`);
            if (!asset || asset.type !== "character" || !typedRefs.characterIds.includes(assetId)) fail(`${path}.assetRefs.variantBindings 引用了非本镜头角色：${assetId}`);
            if (!asset.variants.some((variant) => variant.id === variantId)) fail(`${path}.assetRefs.variantBindings 引用了不存在的角色造型：${variantId}`);
        }
    }
    if (!typedRefs.sceneIds.includes(item.sceneId as string)) fail(`${path}.sceneId 必须存在于 sceneIds`);
}

function validateStoryboard(value: unknown, path: string, shots: Map<string, CinePackShot>, assets: Map<string, CinePackAsset>): asserts value is CinePackStoryboard {
    const item = objectAt(value, path);
    stringAt(item.shotId, `${path}.shotId`);
    stringAt(item.shotGroupId, `${path}.shotGroupId`);
    stringAt(item.prompt, `${path}.prompt`);
    const shot = shots.get(item.shotId as string);
    if (!shot) fail(`${path}.shotId 引用了不存在的镜头`);
    if (shot.shotGroupId !== item.shotGroupId) fail(`${path}.shotGroupId 与镜头不一致`);
    validateMediaDescriptor(item.selectedImage, `${path}.selectedImage`, "media/storyboards/");
    const refs = arrayAt(item.referenceImages, `${path}.referenceImages`) as unknown as CinePackStoryboard["referenceImages"];
    const shotAssetIds = new Set(allAssetRefIds(shot));
    refs.forEach((ref, index) => {
        const refPath = `${path}.referenceImages[${index}]`;
        const object = objectAt(ref, refPath);
        stringAt(object.assetId, `${refPath}.assetId`);
        stringValueAt(object, "versionId", `${refPath}.versionId`);
        stringAt(object.path, `${refPath}.path`);
        if (!(object.path as string).startsWith("media/assets/")) fail(`${refPath}.path 必须位于 media/assets/`);
        const asset = assets.get(object.assetId as string);
        if (!asset || !shotAssetIds.has(object.assetId as string)) fail(`${refPath}.assetId 不属于该镜头依赖`);
        if (object.assetType !== asset.type) fail(`${refPath}.assetType 与资产不一致`);
        if (object.referenceRole !== undefined && !["identity", "look", "asset"].includes(object.referenceRole as string)) fail(`${refPath}.referenceRole 不合法`);
        const validPaths = new Set([
            asset.selectedReference?.path,
            asset.identityReference?.path,
            ...asset.variants.map((variant) => variant.selectedReference?.path),
        ].filter((value): value is string => Boolean(value)));
        if (!validPaths.has(object.path as string)) fail(`${refPath}.path 不属于该资产的基础设定、身份或造型参考`);
    });
}

function validateMediaDescriptor(value: unknown, path = "media", prefix = "media/"): asserts value is CinePackMedia {
    const item = objectAt(value, path);
    stringAt(item.id, `${path}.id`);
    const mediaPath = stringAt(item.path, `${path}.path`);
    validateArchivePath(mediaPath);
    if (!mediaPath.startsWith(prefix)) fail(`${path}.path 必须位于 ${prefix}`);
    if (!SUPPORTED_MIME_TYPES.has(item.mimeType as string)) fail(`${path}.mimeType 不受支持`);
    if (!Number.isInteger(item.bytes) || (item.bytes as number) < 1) fail(`${path}.bytes 必须为正整数`);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail(`${path}.sha256 不合法`);
    stringValueAt(item, "source", `${path}.source`);
    stringValueAt(item, "createdAt", `${path}.createdAt`);
}

function collectMedia(document: CinePackDocument) {
    return [
        ...document.assets.flatMap((asset) => [
            ...(asset.selectedReference ? [asset.selectedReference] : []),
            ...(asset.identityReference ? [asset.identityReference] : []),
            ...asset.variants.flatMap((variant) => (variant.selectedReference ? [variant.selectedReference] : [])),
        ]),
        ...document.storyboards.map((storyboard) => storyboard.selectedImage),
    ];
}

async function readJson(files: Map<string, Blob>, path: string): Promise<unknown> {
    const blob = files.get(path);
    if (!blob) fail(`缺少 ${path}`);
    try {
        return JSON.parse(await blob.text());
    } catch {
        fail(`${path} 不是有效 JSON`);
    }
}

function validateArchivePath(path: string) {
    const normalized = path.replaceAll("\\", "/");
    if (!path || normalized !== path || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => part === ".." || part === ".")) fail(`压缩包路径不安全：${path}`);
}

async function sha256(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function matchesMimeSignature(blob: Blob, mimeType: string) {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (mimeType === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (mimeType === "image/gif") return String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a";
    if (mimeType === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (mimeType === "image/avif") return String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && ["avif", "avis"].includes(String.fromCharCode(...bytes.slice(8, 12)));
    return false;
}

function groupNode(id: string, title: string, x: number, y: number, width: number, height: number, cinepack: NonNullable<CanvasNodeMetadata["cinepack"]>): CanvasNodeData {
    return { id, type: CanvasNodeType.Group, title, position: { x, y }, width, height, metadata: { status: "idle", cinepack } };
}

function textNode(id: string, title: string, x: number, y: number, content: string, groupId: string, cinepack: NonNullable<CanvasNodeMetadata["cinepack"]>): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title, position: { x, y }, width: 330, height: 230, metadata: { content, prompt: content, status: "success", fontSize: 13, groupId, cinepack } };
}

function imageNode(id: string, title: string, x: number, y: number, binding: CinePackMediaBinding | undefined, prompt: string, groupId: string, cinepack: NonNullable<CanvasNodeMetadata["cinepack"]>): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title,
        position: { x, y },
        width: 330,
        height: 230,
        metadata: {
            content: binding?.url || "",
            storageKey: binding?.storageKey,
            naturalWidth: binding?.width,
            naturalHeight: binding?.height,
            bytes: binding?.bytes,
            mimeType: binding?.mimeType,
            prompt,
            composerContent: prompt,
            status: binding ? "success" : "idle",
            generationMode: "image",
            generationType: "edit",
            count: 1,
            groupId,
            cinepack,
        },
    };
}

function videoNode(id: string, title: string, x: number, y: number, prompt: string, aspect: string, duration: string, groupId: string, cinepack: NonNullable<CanvasNodeMetadata["cinepack"]>): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Video,
        title,
        position: { x, y },
        width: 330,
        height: 230,
        metadata: { content: "", prompt, composerContent: prompt, status: "idle", generationMode: "video", size: aspect || "16:9", seconds: duration.match(/\d+(?:\.\d+)?/)?.[0], groupId, cinepack },
    };
}

function nodeId(projectId: string, kind: string, stableId: string) {
    return `cinepack:${encodeURIComponent(projectId)}:${kind}:${encodeURIComponent(stableId)}`;
}

function allAssetRefIds(shot: CinePackShot) {
    return [...shot.assetRefs.characterIds, ...shot.assetRefs.sceneIds, ...shot.assetRefs.propIds];
}

function projectSummary(document: CinePackDocument) {
    const project = document.project;
    return [
        `名称：${project.name}`,
        `类型：${project.type || "未填写"}`,
        `时长：${project.duration || "未填写"}`,
        `画幅：${project.aspect || "未填写"}`,
        `媒介：${project.medium || "未填写"}`,
        `基调：${project.tone || "未填写"}`,
        `语言：${project.language || "未填写"}`,
        `片场流项目 ID：${project.projectId}`,
        `修订 ID：${document.manifest.revisionId}`,
    ].join("\n");
}

function visualStyleSummary(document: CinePackDocument) {
    const style = document.visualStyle;
    return [
        `媒介：${style.medium}`,
        `时代：${style.period}`,
        `地点：${style.location}`,
        `色板：${style.palette.join("、")}`,
        `灯光：${style.lightingRules.join("；")}`,
        `摄影：${style.cameraRules.join("；")}`,
        `质感：${style.textureRules.join("；")}`,
        `负面规则：${style.negativeRules.join("；")}`,
    ].join("\n");
}

function shotPromptSummary(shot: CinePackShot, storyboard?: CinePackStoryboard) {
    return [`镜头：${shot.number} · ${shot.title}`, `时长：${shot.duration}`, shot.story ? `内容：${shot.story}` : "", shot.notes ? `备注：${shot.notes}` : "", "", storyboard?.prompt || "尚未生成故事板"].filter(Boolean).join("\n");
}

function uniqueIds(items: unknown[], key: string, path: string) {
    const ids = new Set<string>();
    items.forEach((item, index) => {
        const value = stringAt(objectAt(item, `${path}[${index}]`)[key], `${path}[${index}].${key}`);
        if (ids.has(value)) fail(`${path}.${key} 重复：${value}`);
        ids.add(value);
    });
    return ids;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
    if (!isObject(value)) fail(`${path} 必须是对象`);
    return value;
}

function arrayAt(value: unknown, path: string, nonEmpty = false): unknown[] {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0)) fail(`${path} 必须是${nonEmpty ? "非空" : ""}数组`);
    return value;
}

function stringAt(value: unknown, path: string) {
    if (typeof value !== "string" || !value.trim()) fail(`${path} 必须是非空字符串`);
    return value;
}

function stringValueAt(object: Record<string, unknown>, key: string, path: string, nonEmpty = false) {
    if (typeof object[key] !== "string" || (nonEmpty && !(object[key] as string).trim())) fail(`${path} 必须是${nonEmpty ? "非空" : ""}字符串`);
}

function stringArrayAt(value: unknown, path: string) {
    const items = arrayAt(value, path);
    if (!items.every((item) => typeof item === "string") || new Set(items).size !== items.length) fail(`${path} 必须是不重复的字符串数组`);
    return items as string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (isObject(value))
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

function fail(message: string): never {
    throw new CinePackValidationError(message);
}
