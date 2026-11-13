import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "antd";
import { LoaderCircle, RefreshCw, ServerOff, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";

type ServerStatus = "checking" | "online" | "offline";

const HEALTH_URL = "/__server-health";
const HEALTH_TIMEOUT_MS = 2_500;
const ONLINE_CHECK_INTERVAL_MS = 5_000;
const OFFLINE_CHECK_INTERVAL_MS = 3_000;
const ONLINE_FAILURE_THRESHOLD = 3;

async function checkServer() {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
        const response = await fetch(`${HEALTH_URL}?t=${Date.now()}`, {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
        });
        if (!response.ok) return false;
        const result = (await response.json()) as { ok?: boolean };
        return result.ok === true;
    } catch {
        return false;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export function ServerAvailabilityGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<ServerStatus>("checking");
    const [hasConnected, setHasConnected] = useState(false);
    const statusRef = useRef<ServerStatus>("checking");
    const checkingRef = useRef(false);
    const lastCheckAtRef = useRef(0);
    const consecutiveFailuresRef = useRef(0);

    const runCheck = useCallback(async () => {
        if (checkingRef.current) return;
        checkingRef.current = true;
        lastCheckAtRef.current = Date.now();
        const online = await checkServer();
        if (online) consecutiveFailuresRef.current = 0;
        else consecutiveFailuresRef.current += 1;
        const tolerateTransientFailure = hasConnected && !online && consecutiveFailuresRef.current < ONLINE_FAILURE_THRESHOLD;
        const nextStatus: ServerStatus = online || tolerateTransientFailure ? "online" : "offline";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        if (online) setHasConnected(true);
        checkingRef.current = false;
    }, [hasConnected]);

    useEffect(() => {
        void runCheck();
        const intervalId = window.setInterval(() => {
            const interval = statusRef.current === "online" ? ONLINE_CHECK_INTERVAL_MS : OFFLINE_CHECK_INTERVAL_MS;
            if (Date.now() - lastCheckAtRef.current < interval) return;
            void runCheck();
        }, 1_000);
        const checkWhenActive = () => {
            if (document.visibilityState === "visible") void runCheck();
        };
        window.addEventListener("online", runCheck);
        window.addEventListener("focus", runCheck);
        document.addEventListener("visibilitychange", checkWhenActive);
        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener("online", runCheck);
            window.removeEventListener("focus", runCheck);
            document.removeEventListener("visibilitychange", checkWhenActive);
        };
    }, [runCheck]);

    return (
        <>
            {hasConnected ? children : null}
            {status !== "online" ? (
                <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 px-6 backdrop-blur-md" role="alertdialog" aria-modal="true" aria-labelledby="server-gate-title">
                    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-7 text-card-foreground shadow-2xl shadow-black/10">
                        <div className="mb-6 flex items-center gap-4">
                            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
                                {status === "checking" ? <LoaderCircle className="size-6 animate-spin" /> : <ServerOff className="size-6 text-red-500" />}
                            </div>
                            <div>
                                <h1 id="server-gate-title" className="text-lg font-semibold tracking-tight">{status === "checking" ? t("serverGate.checkingTitle") : t("serverGate.offlineTitle")}</h1>
                                <p className="mt-1 text-sm text-muted-foreground">{status === "checking" ? t("serverGate.checkingDescription") : t("serverGate.offlineDescription")}</p>
                            </div>
                        </div>
                        {status === "offline" ? (
                            <>
                                <div className="mb-5 flex items-center gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3">
                                    <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 text-sm">
                                        <div className="font-medium">{t("serverGate.startHint")}</div>
                                        <code className="mt-1 block truncate text-xs text-muted-foreground">web/启动.bat</code>
                                    </div>
                                </div>
                                <Button type="primary" block size="large" icon={<RefreshCw className="size-4" />} onClick={() => { setStatus("checking"); void runCheck(); }}>
                                    {t("serverGate.retry")}
                                </Button>
                                <p className="mt-3 text-center text-xs text-muted-foreground">{t("serverGate.autoRetry")}</p>
                                {hasConnected && <Button block className="mt-3" onClick={() => window.dispatchEvent(new Event("canvas-backup-open"))}>服务已断开：先备份当前画布，不要刷新</Button>}
                            </>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}
