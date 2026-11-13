export const CINEPACK_V1_SCHEMA_VERSION = "cinepack.v1" as const;

export type CinePackAssetType = "character" | "scene" | "prop";

export type CinePackManifest = {
    schemaVersion: typeof CINEPACK_V1_SCHEMA_VERSION;
    projectId: string;
    revisionId: string;
    projectName: string;
    exportedAt: string;
    sourceApp: { name: "片场流 Lite"; version: string };
};

export type CinePackMedia = {
    id: string;
    path: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";
    bytes: number;
    sha256: string;
    source: string;
    createdAt: string;
    versionId?: string;
    prompt?: string;
    revisedPrompt?: string;
    styleVersion?: string;
};

export type CinePackAssetVariant = Record<string, unknown> & {
    id: string;
    name: string;
    selectedReference: CinePackMedia | null;
};

export type CinePackAsset = {
    assetId: string;
    type: CinePackAssetType;
    name: string;
    aliases: string[];
    importance: "required" | "recommended" | "optional";
    sourceRefs: Array<{ stage: "story" | "script" | "shotlist" | "existing_registry"; groupId: string; evidence: string }>;
    explicitFacts: Record<string, unknown>;
    inferredFacts: Record<string, unknown>;
    unknownFields: string[];
    ownerAssetIds: string[];
    variants: CinePackAssetVariant[];
    lockedFacts: string[];
    visualRules: string[];
    continuityRules: string[];
    negativeRules: string[];
    promptZh: string;
    negativePromptZh: string;
    identityReference?: CinePackMedia | null;
    selectedReference: CinePackMedia | null;
};

/** CinePack V1 镜头事实。故意无 videoPrompt：Seedance 视频词在画布按 shotGroupId 编译，不进包。 */
export type CinePackShot = {
    shotId: string;
    shotGroupId: string;
    sceneId: string;
    number: number;
    title: string;
    duration: string;
    story: string;
    notes: string;
    assetRefs: { characterIds: string[]; sceneIds: string[]; propIds: string[]; variantBindings?: Record<string, string> };
};

export type CinePackStoryboard = {
    shotId: string;
    shotGroupId: string;
    prompt: string;
    selectedImage: CinePackMedia;
    referenceImages: Array<{ assetId: string; assetType: CinePackAssetType; referenceRole?: "identity" | "look" | "asset"; versionId: string; path: string }>;
};

export type CinePackDocument = {
    manifest: CinePackManifest;
    project: {
        projectId: string;
        name: string;
        type: string;
        duration: string;
        aspect: string;
        medium: string;
        tone: string;
        language: string;
        createdAt: string;
        updatedAt: string;
    };
    content: Record<"story" | "script" | "shotlist", { status: "confirmed" | "unconfirmed"; text: string; revisionNotes: string; updatedAt: string }>;
    visualStyle: {
        medium: string;
        period: string;
        location: string;
        palette: string[];
        lightingRules: string[];
        cameraRules: string[];
        textureRules: string[];
        negativeRules: string[];
    };
    shots: CinePackShot[];
    assets: CinePackAsset[];
    storyboards: CinePackStoryboard[];
};
