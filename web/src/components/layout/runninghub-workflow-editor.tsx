import { Button, Input, Modal, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ChannelModel, ModelChannel } from "@/stores/use-config-store";
import { fetchRhWorkflow } from "@/services/api/runninghub-workflow";
import { RH_WORKFLOW_KIND, parseRhMapping, rhWorkflowId, validateRhMapping, type RhGraph, type RhMapping, type RhSource } from "@/lib/runninghub-workflow";

const sources = [
    { value: "", label: "保留云端默认值" }, { value: "prompt", label: "画布提示词" },
    ...(["image", "video", "audio"] as const).flatMap(kind => Array.from({ length: kind === "image" ? 9 : 3 }, (_, i) => ({ value: `${kind}:${i + 1}`, label: `参考${kind === "image" ? "图" : kind === "video" ? "视频" : "音频"} ${i + 1}` }))),
    { value: "seconds", label: "画布时长（秒）" }, { value: "count", label: "画布出图数量" }, { value: "seed", label: "随机种子" },
];

export function RunningHubWorkflowEditor({ open, channel, model, onSave, onClose }: { open: boolean; channel: ModelChannel; model?: ChannelModel; onSave: (model: ChannelModel) => void; onClose: () => void }) {
    const [id, setId] = useState("");
    const [alias, setAlias] = useState("");
    const [graph, setGraph] = useState<RhGraph>();
    const [mapping, setMapping] = useState<RhMapping>({ kind: RH_WORKFLOW_KIND, workflowId: "", bindings: [], outputNodeId: "", outputClass: "", outputKind: "video" });
    const [filter, setFilter] = useState("");
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const request = useRef<AbortController | null>(null);
    useEffect(() => {
        request.current?.abort(); setBusy(false); setGraph(undefined); setStatus(""); setFilter("");
        setId(model?.name || ""); setAlias(model?.alias || "");
        try { setMapping(parseRhMapping(model?.script || "")); } catch { setMapping({ kind: RH_WORKFLOW_KIND, workflowId: "", bindings: [], outputNodeId: "", outputClass: "", outputKind: "video" }); }
        return () => request.current?.abort();
    }, [open, model, channel.baseUrl, channel.apiKey]);
    const read = async () => {
        request.current?.abort(); const controller = new AbortController(); request.current = controller;
        setBusy(true); setGraph(undefined); setStatus("");
        try {
            const workflowId = rhWorkflowId(id);
            const loaded = await fetchRhWorkflow(channel, workflowId, controller.signal);
            if (controller.signal.aborted) return;
            setId(workflowId); setGraph(loaded);
            setMapping(current => ({ ...current, workflowId, ...(current.workflowId !== workflowId ? { bindings: [], outputNodeId: "", outputClass: "" } : {}) }));
            setStatus(`已读取 ${Object.keys(loaded).length} 个线上 API 节点。此操作未提交生成。请选择输入映射和需要回填的结果节点。`);
        } catch (error) { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "读取失败"); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const fields = Object.entries(graph || {}).flatMap(([nodeId, node]) => Object.entries(node.inputs).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([fieldName, value]) => ({ nodeId, fieldName, classType: node.class_type, title: node._meta?.title || node.class_type, value })));
    const shown = fields.filter(f => filter ? `${f.nodeId} ${f.title} ${f.fieldName}`.toLowerCase().includes(filter.toLowerCase()) : /(?:text|prompt|image|video|audio|seed|noise_seed|seconds|duration|batch_size)$/i.test(f.fieldName) || mapping.bindings.some(b => b.nodeId === f.nodeId && b.fieldName === f.fieldName));
    const save = () => {
        try {
            if (!graph || rhWorkflowId(id) !== mapping.workflowId) throw new Error("请先读取当前工作流");
            validateRhMapping(graph, mapping);
            onSave({ name: mapping.workflowId, alias: alias.trim() || `工作流 ${mapping.workflowId}`, capability: mapping.outputKind, script: JSON.stringify(mapping) });
            onClose();
        } catch (error) { setStatus(error instanceof Error ? error.message : "映射无效"); }
    };
    return <Modal open={open} title="RunningHub 工作流输入与结果" width={920} onCancel={onClose} onOk={save} okText="保存映射" okButtonProps={{ disabled: !graph || busy }} destroyOnHidden>
        <div className="space-y-3">
            <label className="block">工作流链接或 ID<Input aria-label="工作流链接或 ID" value={id} onChange={e => { setId(e.target.value); setGraph(undefined); }} /></label>
            <Button loading={busy} disabled={!channel.apiKey.trim() || !id.trim()} onClick={() => void read()}>读取工作流（不生成）</Button>
            <div role="status" className="text-sm">{status}</div>
            <label className="block">显示名称<Input aria-label="工作流显示名称" value={alias} onChange={e => setAlias(e.target.value)} /></label>
            <div className="flex gap-3">
                <Select aria-label="工作流用途" value={mapping.outputKind} options={[{ value: "video", label: "视频" }, { value: "image", label: "生图" }]} onChange={outputKind => setMapping(m => ({ ...m, outputKind }))} />
                <Select className="min-w-0 flex-1" aria-label="回填结果节点" showSearch optionFilterProp="label" placeholder="选择结果节点（如二采）" value={mapping.outputNodeId || undefined} options={Object.entries(graph || {}).map(([value, n]) => ({ value, label: `#${value} ${n._meta?.title || n.class_type} ${n.inputs.filename_prefix || ""}` }))} onChange={outputNodeId => setMapping(m => ({ ...m, outputNodeId, outputClass: graph![outputNodeId].class_type }))} />
            </div>
            <p className="text-xs text-stone-500">只覆盖下面映射的字段，未映射的比例、画质、时长沿用云端默认值。素材按同类缩略图顺序编号；已映射素材必须全部连接。结果严格按节点 ID 选择；平台失败时未暴露的中间结果无法保证取回。</p>
            {graph ? <><Input aria-label="筛选工作流输入" placeholder="搜索节点 ID、标题或字段；清空时显示常用输入" value={filter} onChange={e => setFilter(e.target.value)} />
                <div className="max-h-80 overflow-y-auto space-y-2">
                    {shown.map(f => <div key={`${f.nodeId}.${f.fieldName}`} className="flex items-center gap-2 border-b border-stone-500/20 pb-2">
                        <div className="flex-1 min-w-0 text-xs"><div>#{f.nodeId} {f.title} · {f.fieldName}</div><div className="truncate opacity-60">默认值：{String(f.value).slice(0, 120)}</div></div>
                        <Select className="w-44" aria-label={`映射 ${f.nodeId}.${f.fieldName}`} value={mapping.bindings.find(b => b.nodeId === f.nodeId && b.fieldName === f.fieldName)?.source || ""} options={sources} onChange={source => setMapping(m => ({ ...m, bindings: [...m.bindings.filter(b => !(b.nodeId === f.nodeId && b.fieldName === f.fieldName)), ...(source ? [{ nodeId: f.nodeId, fieldName: f.fieldName, classType: f.classType, source: source as RhSource }] : [])] }))} />
                    </div>)}
                </div></> : null}
        </div>
    </Modal>;
}
