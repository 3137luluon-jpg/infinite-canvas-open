/** Never persist guessed pixels: slow images must finish decoding or fail explicitly. */
export function readImageDimensions(url: string, timeoutMs = 30_000) {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        const cleanup = () => {
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
        };
        const fail = (message: string) => {
            cleanup();
            reject(new Error(message));
        };
        const timer = setTimeout(() => fail("读取图片尺寸超时，请重试保存图片"), timeoutMs);
        image.onload = () => {
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            if (!width || !height) return fail("图片没有有效的像素尺寸");
            cleanup();
            resolve({ width, height });
        };
        image.onerror = () => fail("读取图片失败，无法确认真实尺寸");
        image.src = url;
    });
}
