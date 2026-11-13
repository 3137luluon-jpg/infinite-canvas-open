type Point = { x: number; y: number };
type Geometry = { length: number; samples: Point[] };
const cache = new Map<string, Geometry>();

/** Arc-length samples of our M/C cubic paths, without synchronous SVG geometry queries. */
export function connectionFlowGeometry(path: string): Geometry | null {
    const cached = cache.get(path);
    if (cached) return cached;
    if (!/^M\s*[-\d.]+\s+[-\d.]+\s+C\s*/.test(path)) return null;
    const values = path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
    if (!values || values.length !== 8 || values.some(value => !Number.isFinite(value))) return null;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
    const points: Point[] = [];
    const distances = [0];
    let length = 0;
    for (let i = 0; i <= 256; i++) {
        const t = i / 256, u = 1 - t;
        const point = { x: u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
            y: u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3 };
        if (i) { length += Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y); distances.push(length); }
        points.push(point);
    }
    let segment = 1;
    const samples = Array.from({ length: 513 }, (_, i) => {
        const target = length * i / 512;
        while (segment < 256 && distances[segment] < target) segment++;
        const start = points[segment - 1], end = points[segment];
        const amount = (target - distances[segment - 1]) / (distances[segment] - distances[segment - 1] || 1);
        return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount };
    });
    const geometry = { length, samples };
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(path, geometry);
    return geometry;
}
