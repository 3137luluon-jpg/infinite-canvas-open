import type { CanvasNodeData } from "@/types/canvas";

export type CanvasAlignment = "grid" | "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
// Canvas units: leaves room for media titles above the next node.
export const CANVAS_ALIGNMENT_GAP = 48;

/** A selected group and its descendants count as one alignment target. */
export function alignmentTargets(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return nodes.filter((node) => {
        if (node.metadata?.hidden || !selectedIds.has(node.id)) return false;
        const visited = new Set([node.id]);
        let parent = byId.get(node.metadata?.groupId || "");
        while (parent && !visited.has(parent.id)) {
            if (parent.type === "group" && !parent.metadata?.hidden && selectedIds.has(parent.id)) return false;
            visited.add(parent.id);
            parent = byId.get(parent.metadata?.groupId || "");
        }
        return true;
    });
}

/** Selecting a single group exposes its direct members for internal layout. */
export function canvasAlignmentSelection(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>) {
    const targets = alignmentTargets(nodes, selectedIds);
    const group = targets.length === 1 && targets[0].type === "group" ? targets[0] : undefined;
    const ids = group
        ? new Set(nodes.filter((node) => !node.metadata?.hidden && node.metadata?.groupId === group.id && node.id !== group.id).map((node) => node.id))
        : new Set(targets.map((node) => node.id));
    return { ids, count: ids.size, groupId: group?.id };
}

export function alignCanvasSelection(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>, alignment: CanvasAlignment) {
    const selection = canvasAlignmentSelection(nodes, selectedIds);
    if (selection.count < 2) return nodes;
    let result = alignCanvasNodes(nodes, selection.ids, alignment);
    // Fit the selected grid frame to its members; otherwise only grow enclosing
    // frames, retaining title space and the positions of unrelated siblings.
    const pending = new Set<string>();
    for (const node of nodes) {
        if (selection.ids.has(node.id) && node.metadata?.groupId) pending.add(node.metadata.groupId);
    }
    const visited = new Set<string>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depth = (id: string) => {
        const chain = new Set<string>();
        let current: string | undefined = id;
        while (current && !chain.has(current)) {
            chain.add(current);
            current = byId.get(current)?.metadata?.groupId;
        }
        return chain.size;
    };
    while (pending.size) {
        const id = [...pending].sort((a, b) => depth(b) - depth(a))[0];
        pending.delete(id);
        if (visited.has(id)) continue;
        visited.add(id);
        const group = result.find((node) => node.id === id && node.type === "group" && !node.metadata?.hidden);
        const children = result.filter((node) => node.id !== id && node.metadata?.groupId === id && !node.metadata?.hidden);
        if (!group || !children.length) continue;
        const compact = alignment === "grid" && id === selection.groupId;
        const x = Math.min(compact ? Infinity : group.position.x, ...children.map((node) => node.position.x - 24));
        const y = Math.min(compact ? Infinity : group.position.y, ...children.map((node) => node.position.y - 56));
        const right = Math.max(compact ? -Infinity : group.position.x + group.width, ...children.map((node) => node.position.x + node.width + 24));
        const bottom = Math.max(compact ? -Infinity : group.position.y + group.height, ...children.map((node) => node.position.y + node.height + 24));
        if (x !== group.position.x || y !== group.position.y || right - x !== group.width || bottom - y !== group.height) {
            result = result.map((node) => node.id === id ? { ...node, position: { x, y }, width: right - x, height: bottom - y } : node);
        }
        if (group.metadata?.groupId) pending.add(group.metadata.groupId);
    }
    return result;
}

export function alignCanvasNodes(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>, alignment: CanvasAlignment) {
    const targets = alignmentTargets(nodes, selectedIds);
    if (targets.length < 2) return nodes;
    const left = Math.min(...targets.map((node) => node.position.x));
    const right = Math.max(...targets.map((node) => node.position.x + node.width));
    const top = Math.min(...targets.map((node) => node.position.y));
    const bottom = Math.max(...targets.map((node) => node.position.y + node.height));
    const deltas = new Map(targets.map((node) => {
        let { x, y } = node.position;
        if (alignment === "left") x = left;
        if (alignment === "center-x") x = (left + right - node.width) / 2;
        if (alignment === "right") x = right - node.width;
        if (alignment === "top") y = top;
        if (alignment === "center-y") y = (top + bottom - node.height) / 2;
        if (alignment === "bottom") y = bottom - node.height;
        return [node.id, { x: x - node.position.x, y: y - node.position.y }] as const;
    }));
    // Keep reading order and existing generous gaps; only push crowded targets
    // forward on the other axis. Group descendants inherit the final delta.
    const axis = alignment === "left" || alignment === "center-x" || alignment === "right" ? "y" : "x";
    const size = axis === "y" ? "height" : "width";
    const ordered = alignment === "grid" ? [] : [...targets].sort((a, b) => a.position[axis] - b.position[axis]);
    let nextStart = -Infinity;
    for (const node of ordered) {
        const start = Math.max(node.position[axis], nextStart);
        deltas.set(node.id, { ...deltas.get(node.id)!, [axis]: start - node.position[axis] });
        nextStart = start + node[size] + CANVAS_ALIGNMENT_GAP;
    }
    if (alignment === "grid") {
        // Read visual rows left-to-right, tolerating slightly uneven node tops.
        const rows: CanvasNodeData[][] = [];
        const tolerance = Math.max(1, Math.min(...targets.map(node => node.height)) / 2);
        for (const node of [...targets].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)) {
            const row = rows[rows.length - 1];
            if (row && node.position.y - row[0].position.y < tolerance) row.push(node);
            else rows.push([node]);
        }
        const items = rows.flatMap(row => row.sort((a, b) => a.position.x - b.position.x));
        const columns = Math.ceil(Math.sqrt(items.length));
        const columnWidths = Array<number>(columns).fill(0);
        const rowHeights = Array<number>(Math.ceil(items.length / columns)).fill(0);
        items.forEach((node, index) => {
            columnWidths[index % columns] = Math.max(columnWidths[index % columns], node.width);
            rowHeights[Math.floor(index / columns)] = Math.max(rowHeights[Math.floor(index / columns)], node.height);
        });
        const offsets = (sizes: number[], origin: number) => {
            let next = origin;
            return sizes.map(size => { const start = next; next += size + CANVAS_ALIGNMENT_GAP; return start; });
        };
        const xs = offsets(columnWidths, left);
        const ys = offsets(rowHeights, top);
        items.forEach((node, index) => deltas.set(node.id, {
            x: xs[index % columns] - node.position.x,
            y: ys[Math.floor(index / columns)] - node.position.y,
        }));
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let changed = false;
    const result = nodes.map((node) => {
        if (node.metadata?.hidden) return node;
        let target = node;
        const visited = new Set<string>();
        while (!deltas.has(target.id) && target.metadata?.groupId && !visited.has(target.id)) {
            visited.add(target.id);
            const parent = byId.get(target.metadata.groupId);
            if (!parent || parent.type !== "group") break;
            target = parent;
        }
        const delta = deltas.get(target.id);
        if (!delta || (!delta.x && !delta.y)) return node;
        changed = true;
        return { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } };
    });
    return changed ? result : nodes;
}
