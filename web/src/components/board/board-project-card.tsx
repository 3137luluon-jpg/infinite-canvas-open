import { App, Button, Input, Modal } from "antd";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useBoardStore } from "@/stores/board/use-board-store";
import type { BoardProject } from "@/types/board";

export function BoardProjectCard({ board }: { board: BoardProject }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const renameBoard = useBoardStore((state) => state.renameBoard);
    const deleteBoards = useBoardStore((state) => state.deleteBoards);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(board.title);
    const videoCount = board.shots.reduce((sum, shot) => sum + shot.videos.filter((video) => video.status === "success" && Boolean(video.content)).length, 0);
    const save = () => {
        if (!renameBoard(board.id, title)) return message.warning("看板名称不能为空，也不能与已有看板重名");
        setEditing(false);
    };

    return (
        <article className="group flex aspect-square w-full cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && navigate(`/boards/${board.id}`)}>
            <div>
                {editing ? (
                    <Input value={title} autoFocus onClick={(event) => event.stopPropagation()} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && save()} />
                ) : <h2 className="truncate text-xl font-semibold">{board.title}</h2>}
                <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">{board.shots.length} 个分镜 · {videoCount} 个视频</p>
            </div>
            <div className="mt-8 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">更新于 {new Date(board.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <><Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={save} /><Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={() => { setTitle(board.title); setEditing(false); }} /></>
                    ) : (
                        <><Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)} /><Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => Modal.confirm({ title: "删除看板", content: `确定删除“${board.title}”吗？`, okText: "删除", okButtonProps: { danger: true }, cancelText: "取消", onOk: () => deleteBoards([board.id]) })} /></>
                    )}
                </div>
            </div>
        </article>
    );
}
