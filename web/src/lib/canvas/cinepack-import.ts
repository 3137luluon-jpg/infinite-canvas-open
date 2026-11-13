import { commitCinePackArchive } from "@/lib/canvas/cinepack-import-transaction";
import { readCinePackV1, type CinePackBuildResult } from "@/lib/canvas/cinepack-v1";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export type CinePackImportResult = CinePackBuildResult["counts"] & { projectId: string; title: string };

/**
 * CinePack 导入事务：先完整校验，再写媒体，最后一次性加入项目。
 * 任一步失败都会恢复导入前的项目列表并删除本次已写入的媒体。
 */
export async function importCinePackV1(file: Blob): Promise<CinePackImportResult> {
    const archive = await readCinePackV1(file);
    const result = await commitCinePackArchive(archive, {
        getProjects: () => useCanvasStore.getState().projects,
        importProject: (project) => useCanvasStore.getState().importProject(project),
        replaceProjects: (projects) => useCanvasStore.getState().replaceProjects(projects),
        flushPersist: () => useCanvasStore.getState().flushPersist(),
        uploadImage,
        deleteStoredImages,
    });
    return { projectId: result.projectId, title: archive.manifest.projectName, ...result.counts };
}
