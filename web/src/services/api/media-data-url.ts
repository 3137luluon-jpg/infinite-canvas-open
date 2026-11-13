/** Data URLs use comma as the payload separator, so MIME codec parameters containing commas must be removed. */
export function safeMediaDataUrlMimeType(value: string) {
    const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
    return /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
}

export function normalizeMediaDataUrl(dataUrl: string) {
    if (!/^data:/i.test(dataUrl)) return dataUrl;
    const separator = dataUrl.indexOf(",");
    const base64Marker = dataUrl.lastIndexOf(";base64,");
    if (separator < 0 || base64Marker < separator) return dataUrl;
    const mimeType = safeMediaDataUrlMimeType(dataUrl.slice(5, separator));
    return `data:${mimeType};base64,${dataUrl.slice(base64Marker + ";base64,".length)}`;
}

export function mediaDataUrlHeader(mimeType: string) {
    return `data:${safeMediaDataUrlMimeType(mimeType)};base64,`;
}

export function mediaBlobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const mimeType = safeMediaDataUrlMimeType(blob.type);
        const safeBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("无法读取本地媒体文件"));
        reader.readAsDataURL(safeBlob);
    });
}
