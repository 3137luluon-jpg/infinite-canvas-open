import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { buildCanvasProjectsArchive, canvasExportFileExtension, safeCanvasExportFileName } from "@/lib/canvas/canvas-project-archive";
import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    let missingCount = 0;
    const zip = await buildCanvasProjectsArchive(projects, (storageKey) => (storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey)), count => { missingCount = count; });
    const zipName = resolveExportFileName(fileName);
    saveAs(zip, `${zipName}.zip`);
    return { missingCount };
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, canvasExportFileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, canvasExportFileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${resolveExportFileName(fileName)}.zip`);
}

function safeFileName(value: string) {
    return safeCanvasExportFileName(value);
}

function resolveExportFileName(value: string) {
    return safeFileName(value) || safeFileName(i18n.t("canvas.export.defaultProjectName")) || "canvas-export";
}
