type ProjectRef = { id: string };

/** UI evidence only: never skip the real Worker/disk verification. */
export function sameBackupScope(saved: readonly ProjectRef[] | undefined, current: readonly ProjectRef[], projectId?: string) {
    if (!saved?.length || !current.length) return false;
    if (projectId) {
        const before = saved.find((project) => project.id === projectId);
        return !!before && before === current.find((project) => project.id === projectId);
    }
    return saved.length === current.length && saved.every((project, index) => project === current[index]);
}

export function backupSuccessMessage(result: { complete?: boolean; cacheWarning?: string; metrics?: { sourceLoads: number; mediaWrites: number } }, structureUnchanged: boolean) {
    if (!result.complete) return null;
    if (structureUnchanged && !result.cacheWarning && result.metrics?.sourceLoads === 0 && result.metrics.mediaWrites === 0) return "已是最新备份";
    return "备份完成";
}
