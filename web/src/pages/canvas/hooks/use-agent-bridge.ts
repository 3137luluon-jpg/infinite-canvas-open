import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";

export type AgentGenerateNode = (nodeId: string, mode: "text" | "image" | "video" | "audio", prompt: string) => Promise<void>;

type GenerateNodeRef = MutableRefObject<AgentGenerateNode | null>;
type GenerateOp = Extract<CanvasAgentOp, { type: "run_generation" }>;

type AgentBridgeParams = {
    publishAgentContext?: boolean;
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { publishAgentContext = true, projectId, title, nodes, connections, selectedNodeIds, viewport, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const flushPersist = useCanvasStore((state) => state.flushPersist);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    const selectedIds = useMemo(() => Array.from(selectedNodeIds), [selectedNodeIds]);
    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({
        projectId, title: projectTitle, nodes, connections, selectedNodeIds: selectedIds, viewport,
    }), [connections, projectTitle, nodes, projectId, selectedIds, viewport]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const generationOps = safeOps.filter((op): op is GenerateOp => op.type === "run_generation" && Boolean(op.nodeId));
            const edits = safeOps.filter(op => op.type !== "run_generation");
            const next = edits.length ? applyCanvasAgentOps(before, edits) : before;
            if (edits.length) {
                nodesRef.current = next.nodes;
                connectionsRef.current = next.connections;
                selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
                viewportRef.current = next.viewport;
                setAgentUndoSnapshot(before);
                setNodes(next.nodes);
                setConnections(next.connections);
                setSelectedNodeIds(new Set(next.selectedNodeIds));
                setSelectedConnectionId(null);
                setViewport(next.viewport);
                setContextMenu(null);
                updateProject(projectId, { nodes: next.nodes, connections: next.connections, viewport: next.viewport });
                void flushPersist();
            }
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [flushPersist, projectTitle, projectId, updateProject],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        updateProject(projectId, { nodes: agentUndoSnapshot.nodes, connections: agentUndoSnapshot.connections, viewport: agentUndoSnapshot.viewport });
        void flushPersist();
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, flushPersist, projectTitle, projectId, updateProject]);

    useEffect(() => {
        if (!publishAgentContext) return;
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, publishAgentContext, setAgentCanvasContext, undoAgentOps]);

    // Context remains available between frames; clear it only on route teardown.
    useEffect(() => () => setAgentCanvasContext(null), [projectId, setAgentCanvasContext]);

    useEffect(() => {
        if (!publishAgentContext) setAgentCanvasContext(null);
    }, [publishAgentContext, setAgentCanvasContext]);

    return { applyAgentOps };
}
