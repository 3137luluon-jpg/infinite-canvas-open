import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types/canvas.ts";

/** The edit order is independent of canvas coordinates and generation completion order. */
export type VideoOrganization = {
    sectionId: string;
    sectionLabel: string;
    sectionOrder: number;
    shotId: string;
    shotLabel: string;
    shotOrder: number;
    versionOrder: number;
    orderLocked?: boolean;
    originNodeId?: string;
    createdAt?: number;
    adoptedStorageKey?: string;
    needsReview?: boolean;
    evidence?: "manual" | "source" | "lineage" | "prompt" | "group" | "unassigned";
};
export type VideoLibraryEntry = { node: CanvasNodeData; organization: VideoOrganization; latest: boolean; adopted: boolean };
export type VideoLibraryShot = { id: string; label: string; order: number; entries: VideoLibraryEntry[] };
export type VideoLibrarySection = { id: string; label: string; order: number; shots: VideoLibraryShot[] };

const compareText = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true });
const order = (n: number) => (Number.isFinite(n) ? n : 0);
export function videoMediaReady(node: CanvasNodeData) {
    return Boolean(node.metadata?.storageKey && node.metadata.content && node.metadata.status !== "loading" && node.metadata.status !== "error");
}
export function spatialOrder(nodes: CanvasNodeData[]) {
    const remaining = [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || compareText(a.id, b.id));
    const result: CanvasNodeData[] = [];
    while (remaining.length) {
        const anchor = remaining[0];
        const tolerance = Math.max(24, Math.min(anchor.height, 340) * 0.45);
        const row = remaining.filter((n) => n.position.y <= anchor.position.y + tolerance).sort((a, b) => a.position.x - b.position.x || compareText(a.id, b.id));
        const ids = new Set(row.map((n) => n.id));
        result.push(...row);
        for (let i = remaining.length - 1; i >= 0; i--) if (ids.has(remaining[i].id)) remaining.splice(i, 1);
    }
    return result;
}
function versionTime(node: CanvasNodeData) {
    return node.metadata?.videoOrganization?.createdAt || node.metadata?.generationPhaseStartedAt || Number(node.id.match(/-(\d{13})-/)?.[1]) || 0;
}
function promptKey(node: CanvasNodeData, connections: CanvasConnection[]) {
    const prompt = node.metadata?.prompt?.replace(/\r\n/g, "\n").trim();
    if (!prompt || prompt.length < 30) return "";
    // Equal wording with different actual reference assets is not sufficient evidence.
    const references = node.metadata?.references?.length ? node.metadata.references : connections.filter((c) => c.toNodeId === node.id).map((c) => c.fromNodeId);
    return JSON.stringify([prompt, references || []]);
}

export function buildVideoLibrary(nodes: CanvasNodeData[], connections: CanvasConnection[] = []): VideoLibrarySection[] {
    const videos = nodes.filter((n) => n.type === CanvasNodeType.Video && !n.metadata?.hidden);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const spatialVideos = spatialOrder(videos);
    const rank = new Map(spatialVideos.map((n, i) => [n.id, i + 1]));
    const promptKeys = new Map(videos.map((node) => [node.id, promptKey(node, connections)]));
    const groupRank = new Map(spatialOrder(nodes.filter((n) => n.type === CanvasNodeType.Group)).map((n, i) => [n.id, i + 1000]));
    const assignments = new Map<string, VideoOrganization>();
    for (const node of videos) {
        const explicit = node.metadata?.videoOrganization;
        if (explicit?.sectionId && explicit.shotId) {
            assignments.set(node.id, { ...explicit });
            continue;
        }
        const source = node.metadata?.cinepack;
        const stable = node.id.match(/^(.*?)-([RU]\d+)-v(\d+)$/i);
        if (source?.shotId) {
            const group = byId.get(node.metadata?.groupId || "");
            const shotNumber = Number(node.title.match(/镜头\s*(\d+)/)?.[1]);
            assignments.set(node.id, {
                sectionId: `cinepack:${source.projectId}:${source.shotGroupId || "shots"}`,
                sectionLabel: group?.title || source.shotGroupId || "分镜",
                sectionOrder: groupRank.get(group?.id || "") || 1,
                shotId: `cinepack:${source.projectId}:${source.shotId}`,
                shotLabel: node.title,
                shotOrder: shotNumber || rank.get(node.id)!,
                versionOrder: 1,
                evidence: "source",
            });
        } else if (stable) {
            const family = stable[1];
            const group = nodes.find((n) => n.type === CanvasNodeType.Group && n.id === family.replace(/^video-/, "group-") + `-v${stable[3]}`);
            const familyGroup = group || nodes.find((n) => n.type === CanvasNodeType.Group && n.id.startsWith(family.replace(/^video-/, "group-") + "-v"));
            assignments.set(node.id, {
                sectionId: family,
                sectionLabel: familyGroup?.title.replace(/(?:重拉)?\s*v\d+.*$/i, "").trim() || "原始镜头序列",
                sectionOrder: Number(stable[2].slice(1)) + 1,
                shotId: `${family}:${stable[2].toUpperCase()}`,
                shotLabel: stable[2].toUpperCase(),
                shotOrder: Number(stable[2].slice(1)) + 1,
                versionOrder: Number(stable[3]),
                evidence: "source",
            });
        }
    }
    // A dedicated repair group such as “R16 v005” is explicit shot provenance.
    // A mixed “R06 / R13” group is deliberately not treated as a single shot.
    for (const node of videos) {
        if (assignments.has(node.id)) continue;
        const group = byId.get(node.metadata?.groupId || "");
        const codes = [...new Set(group?.title.match(/\b[RU]\d+\b/gi)?.map((s) => s.toUpperCase()) || [])];
        if (codes.length !== 1) continue;
        const candidates = new Map([...assignments.values()].filter((a) => a.evidence === "source" && a.shotLabel === codes[0]).map((a) => [a.shotId, a]));
        if (candidates.size === 1) assignments.set(node.id, { ...[...candidates.values()][0], versionOrder: 0, adoptedStorageKey: undefined, evidence: "group" });
    }
    const promptAnchors = new Map<string, Map<string, VideoOrganization>>();
    for (const node of videos) {
        const assignment = assignments.get(node.id);
        const key = promptKeys.get(node.id)!;
        if (!assignment || !key) continue;
        if (!promptAnchors.has(key)) promptAnchors.set(key, new Map());
        promptAnchors.get(key)!.set(assignment.shotId, assignment);
    }
    // Resolve a known copy/trim lineage first, then exact prompt + exact references.
    for (let pass = 0; pass < videos.length; pass++) {
        let changed = false;
        for (const node of videos) {
            if (assignments.has(node.id)) continue;
            const parentId = node.metadata?.videoOrganization?.originNodeId || node.metadata?.sourceVideoId;
            const parent = assignments.get(parentId || "");
            const anchors = promptAnchors.get(promptKeys.get(node.id)!);
            const inferred = parent || (anchors?.size === 1 ? [...anchors.values()][0] : undefined);
            if (inferred) {
                assignments.set(node.id, { ...inferred, versionOrder: 0, adoptedStorageKey: undefined, originNodeId: parentId, evidence: parent ? "lineage" : "prompt" });
                changed = true;
            }
        }
        if (!changed) break;
    }
    const unknownPrompts = new Map<string, VideoOrganization>();
    const knownGroupFamilies = new Map<string, Map<string, VideoOrganization>>();
    const groupRows = new Map<string, CanvasNodeData[]>();
    for (const node of spatialVideos) {
        const group = node.metadata?.groupId;
        if (group) groupRows.set(group, [...(groupRows.get(group) || []), node]);
    }
    for (const node of videos) {
        const group = node.metadata?.groupId;
        const a = assignments.get(node.id);
        if (!group || !a || a.needsReview) continue;
        if (!knownGroupFamilies.has(group)) knownGroupFamilies.set(group, new Map());
        knownGroupFamilies.get(group)!.set(a.sectionId, a);
    }
    for (const node of spatialVideos) {
        if (assignments.has(node.id)) continue;
        const group = byId.get(node.metadata?.groupId || "");
        if (!node.metadata?.model && node.metadata?.storageKey && !node.metadata?.prompt) {
            assignments.set(node.id, {
                sectionId: "references",
                sectionLabel: "参考视频与截取",
                sectionOrder: 999998,
                shotId: `reference:${node.metadata.sourceVideoId || node.id}`,
                shotLabel: byId.get(node.metadata.sourceVideoId || node.id)?.title || node.title,
                shotOrder: rank.get(node.id)!,
                versionOrder: 0,
                needsReview: true,
                evidence: "group",
            });
            continue;
        }
        const key = promptKeys.get(node.id)!;
        const localKey = `${group?.id || "unassigned"}:${key}`;
        const sibling = key ? unknownPrompts.get(localKey) : undefined;
        const groupFamilies = knownGroupFamilies.get(group?.id || "");
        const family = group && groupFamilies?.size === 1 ? [...groupFamilies.values()][0] : undefined;
        let inferredOrder = rank.get(node.id)!;
        if (family && group) {
            // Missing legacy lineage is kept unresolved, but its established position
            // between numbered originals is retained instead of moving it to the end.
            const row = groupRows.get(group.id)!;
            const index = row.indexOf(node);
            const anchors = row.flatMap((n, i) => {
                const a = assignments.get(n.id);
                return a && !a.needsReview && a.sectionId === family.sectionId ? [{ index: i, order: a.shotOrder }] : [];
            });
            const before = anchors.filter((a) => a.index < index).at(-1);
            const after = anchors.find((a) => a.index > index);
            if (before && after && after.order > before.order) inferredOrder = before.order + ((after.order - before.order) * (index - before.index)) / (after.index - before.index);
            else if (before) inferredOrder = before.order + (index - before.index) / (row.length + 1);
            else if (after) inferredOrder = after.order - (after.index - index) / (row.length + 1);
        }
        const organization: VideoOrganization = sibling
            ? { ...sibling, versionOrder: 0 }
            : {
                  sectionId: family?.sectionId || (group ? `group:${group.id}` : "unassigned"),
                  sectionLabel: family?.sectionLabel || (group?.title === "组" ? `未命名组 ${groupRank.get(group.id)! - 999}` : group?.title || "待归类"),
                  sectionOrder: family?.sectionOrder || (group ? groupRank.get(group.id)! : 999999),
                  shotId: `node:${node.id}`,
                  shotLabel: node.title,
                  shotOrder: inferredOrder,
                  versionOrder: 0,
                  needsReview: true,
                  evidence: group ? "group" : "unassigned",
              };
        assignments.set(node.id, organization);
        if (key && !sibling) unknownPrompts.set(localKey, organization);
    }
    // Match copies of an unnumbered shot only when a unique existing group anchors it.
    // Never merge two established shots just because their prompts happen to match.
    for (const node of videos) {
        const current = assignments.get(node.id)!;
        if (current.evidence !== "unassigned") continue;
        const key = promptKeys.get(node.id)!;
        if (!key) continue;
        const candidates = new Map(
            videos
                .filter((n) => Boolean(n.metadata?.groupId) && promptKeys.get(n.id) === key)
                .map((n) => {
                    const a = assignments.get(n.id)!;
                    return [a.shotId, a] as const;
                }),
        );
        if (candidates.size === 1) assignments.set(node.id, { ...[...candidates.values()][0], versionOrder: 0, adoptedStorageKey: undefined, evidence: "prompt" });
    }
    const sections = new Map<string, VideoLibrarySection>();
    const shots = new Map<string, VideoLibraryShot>();
    for (const node of videos) {
        const organization = assignments.get(node.id)!;
        let section = sections.get(organization.sectionId);
        if (!section) {
            section = { id: organization.sectionId, label: organization.sectionLabel, order: order(organization.sectionOrder), shots: [] };
            sections.set(section.id, section);
        }
        section.order = Math.min(section.order, order(organization.sectionOrder));
        const key = `${section.id}:${organization.shotId}`;
        let shot = shots.get(key);
        if (!shot) {
            shot = { id: organization.shotId, label: organization.shotLabel, order: order(organization.shotOrder), entries: [] };
            shots.set(key, shot);
            section.shots.push(shot);
        }
        shot.entries.push({ node, organization, latest: false, adopted: Boolean(node.metadata?.storageKey && organization.adoptedStorageKey === node.metadata.storageKey && videoMediaReady(node)) });
    }
    const result = [...sections.values()].sort((a, b) => a.order - b.order || compareText(a.id, b.id));
    for (const section of result) {
        section.shots.sort((a, b) => a.order - b.order || compareText(a.id, b.id));
        for (const shot of section.shots) {
            shot.entries.sort((a, b) => {
                if (a.organization.orderLocked && b.organization.orderLocked) return a.organization.versionOrder - b.organization.versionOrder || compareText(a.node.id, b.node.id);
                const at = versionTime(a.node),
                    bt = versionTime(b.node);
                return at && bt ? at - bt || compareText(a.node.id, b.node.id) : (a.organization.versionOrder || 0) - (b.organization.versionOrder || 0) || rank.get(a.node.id)! - rank.get(b.node.id)! || compareText(a.node.id, b.node.id);
            });
            shot.entries.forEach((entry, i) => {
                entry.organization = { ...entry.organization, sectionLabel: section.label, sectionOrder: section.order, shotLabel: shot.label, shotOrder: shot.order, versionOrder: i + 1 };
            });
            const candidates = shot.entries.filter((entry) => videoMediaReady(entry.node));
            if (candidates.length) candidates[candidates.length - 1].latest = true;
        }
    }
    return result;
}

export const videoLibraryEntries = (sections: VideoLibrarySection[]) => sections.flatMap((section) => section.shots.flatMap((shot) => shot.entries));

export function currentVideoOrganization(source: CanvasNodeData, nodes: CanvasNodeData[]): VideoOrganization | undefined {
    const original = videoLibraryEntries(buildVideoLibrary(nodes)).find((e) => e.node.id === source.id)?.organization;
    return original ? { ...original, createdAt: original.createdAt || versionTime(source) || undefined } : undefined;
}

export function inheritVideoOrganization(source: CanvasNodeData, nodes: CanvasNodeData[], createdAt = Date.now()): VideoOrganization | undefined {
    if (source.type !== CanvasNodeType.Video) return undefined;
    const entries = videoLibraryEntries(buildVideoLibrary(nodes));
    const original = entries.find((e) => e.node.id === source.id)?.organization;
    if (!original) return undefined;
    const versions = entries.filter((e) => e.organization.shotId === original.shotId && e.organization.sectionId === original.sectionId);
    return { ...original, versionOrder: Math.max(0, ...versions.map((e) => e.organization.versionOrder)) + 1, orderLocked: true, originNodeId: source.id, createdAt, adoptedStorageKey: undefined, evidence: "lineage" };
}

/** Keep the previous successful media when retrying a populated video in-place. */
export function preservePreviousVideo(nodes: CanvasNodeData[], previous: CanvasNodeData, newStorageKey: string): CanvasNodeData[] {
    if (!previous.metadata?.storageKey || previous.metadata.storageKey === newStorageKey) return nodes;
    const archiveId = `video-history:${previous.id}:${previous.metadata.storageKey}`;
    if (nodes.some((n) => n.id === archiveId)) return nodes;
    const organization = videoLibraryEntries(buildVideoLibrary(nodes)).find((e) => e.node.id === previous.id)?.organization;
    return [
        ...nodes,
        {
            ...previous,
            id: archiveId,
            position: { x: previous.position.x, y: previous.position.y + previous.height + 48 },
            metadata: { ...previous.metadata, status: "success", generationJobId: undefined, videoOrganization: organization ? { ...organization, createdAt: organization.createdAt || versionTime(previous) } : undefined },
        },
    ];
}
