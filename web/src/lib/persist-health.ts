export type PersistHealth = { key: string; error: string; at: number };
let errors: PersistHealth[] = [];
const listeners = new Set<() => void>();
export const getPersistErrors = () => errors;
export const subscribePersistErrors = (fn: () => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};
export function reportPersistError(key: string, error: unknown) {
    errors = [...errors.filter((item) => item.key !== key), { key, error: error instanceof Error ? error.message : String(error), at: Date.now() }];
    listeners.forEach((fn) => fn());
}
export function clearPersistError(key: string) {
    if (!errors.some((item) => item.key === key)) return;
    errors = errors.filter((item) => item.key !== key);
    listeners.forEach((fn) => fn());
}
