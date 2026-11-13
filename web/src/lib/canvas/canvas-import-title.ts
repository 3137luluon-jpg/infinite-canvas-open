export function importedCanvasTitle(title: string | undefined, existing: string[], fallback: string) {
    const requested = title?.trim() || fallback;
    const used = new Set(existing.map((value) => value.trim().toLocaleLowerCase()));
    if (!used.has(requested.toLocaleLowerCase())) return requested;
    for (let index = 1; ; index++) {
        const candidate = `${requested}（导入副本${index === 1 ? "" : ` ${index}`}）`;
        if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    }
}
