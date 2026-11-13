export type ShotDraft = {
    requestId: string; shotNodeId: string; zh: string; en: string; seconds: string;
    warnings: string[];
};
export type ShotCompilation = {
    version: 1; status: "running" | "draft" | "applied" | "failed";
    signature: string; updatedAt: string; requestId?: string; error?: string; draft?: ShotDraft;
    startedAt?: string; finishedAt?: string; model?: string;
    sourceMode: "compile" | "assemble";
};
