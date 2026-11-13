import { useEffect, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";

export function CodexExecutionTime() {
    const execution = useAgentStore(s => s.execution);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        setNow(Date.now());
        if (!execution || execution.finishedAt) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [execution]);
    const seconds = execution ? Math.max(0, Math.floor(((execution.finishedAt || now) - execution.startedAt) / 1000)) : null;
    return <div className="my-2 text-xs text-stone-500 dark:text-stone-400">
        Codex 模型：gpt-5.6-sol · 低推理强度
        {execution && <div>本次提交：{execution.model} · {execution.finishedAt ? "用时" : "已运行"} {seconds} s</div>}
    </div>;
}
