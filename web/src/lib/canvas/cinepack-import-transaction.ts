import { buildCinePackCanvasProject, type CinePackArchive, type CinePackBuildResult, type CinePackMediaBinding } from "@/lib/canvas/cinepack-v1";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

type CinePackImportDependencies = {
    getProjects: () => CanvasProject[];
    importProject: (project: Partial<CanvasProject>) => string;
    replaceProjects: (projects: CanvasProject[]) => void;
    flushPersist: () => Promise<void>;
    uploadImage: (blob: Blob) => Promise<CinePackMediaBinding>;
    deleteStoredImages: (keys: Iterable<string>) => Promise<void>;
};

export async function commitCinePackArchive(archive: CinePackArchive, dependencies: CinePackImportDependencies): Promise<CinePackBuildResult & { projectId: string }> {
    const previousProjects = dependencies.getProjects();
    const writtenStorageKeys: string[] = [];
    let projectAdded = false;
    try {
        const bindings = new Map<string, CinePackMediaBinding>();
        for (const media of archive.media) {
            const blob = archive.files.get(media.path)!;
            const uploaded = await dependencies.uploadImage(blob.slice(0, blob.size, media.mimeType));
            writtenStorageKeys.push(uploaded.storageKey);
            bindings.set(media.path, uploaded);
        }
        const built = buildCinePackCanvasProject(archive, bindings);
        const projectId = dependencies.importProject(built.project);
        projectAdded = true;
        await dependencies.flushPersist();
        return { projectId, ...built };
    } catch (error) {
        if (projectAdded) {
            dependencies.replaceProjects(previousProjects);
            await dependencies.flushPersist().catch(() => undefined);
        }
        await dependencies.deleteStoredImages(writtenStorageKeys).catch(() => undefined);
        throw error;
    }
}
