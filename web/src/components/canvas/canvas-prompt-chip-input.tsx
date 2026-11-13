import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Image, Popover } from "antd";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";

import { AgentCanvasReferencePreview } from "@/components/agent/agent-canvas-reference-preview";
import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasMentionDisplayName, canvasMentionKey, buildCanvasMentionToneMap, canvasMentionTone, type CanvasMentionTone } from "@/lib/canvas/canvas-mention-style";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { isImeComposing, isPlainEnterKey } from "@/lib/keyboard-event";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    value: string;
    references: CanvasResourceReference[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    containerClassName?: string;
    className?: string;
    style?: CSSProperties;
    placeholder?: string;
    /** 使用稳定节点 ID 序列化 @ 引用；CinePack 镜头需要避免连线顺序变化后引用错图。 */
    stableNodeMentions?: boolean;
};

export type CanvasPromptChipInputHandle = {
    insertReference: (reference: CanvasResourceReference) => void;
    focus: () => void;
};

type MentionState = {
    query: string;
    rect: DOMRect | null;
};

type Token = { type: "text"; value: string } | { type: "reference"; label?: string; nodeId?: string; raw: string };

type ReferenceHover = {
    reference: CanvasResourceReference;
    left: number;
    top: number;
    width: number;
    height: number;
};

// Prompt-panel contentEditable input: @ references embed thumbnail chips instead of plain label text.
// Serialization converts chips back to reference labels so the generated value matches the former textarea semantics.
export const CanvasPromptChipInput = forwardRef<CanvasPromptChipInputHandle, Props>(function CanvasPromptChipInput({ value, references, onChange, onSubmit, containerClassName, className, style, placeholder, stableNodeMentions = false }, ref) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const lastEmittedRef = useRef(value);
    const savedRangeRef = useRef<Range | null>(null);
    const undoStackRef = useRef<string[]>([]);
    const redoStackRef = useRef<string[]>([]);
    const applyingHistoryRef = useRef(false);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [referenceHover, setReferenceHover] = useState<ReferenceHover | null>(null);

    const activeReferences = useMemo(() => references.filter((item) => item.active), [references]);
    const referenceByLabel = useMemo(() => new Map(activeReferences.map((item) => [item.label, item])), [activeReferences]);
    const referenceByNodeId = useMemo(() => new Map(activeReferences.map((item) => [item.nodeId, item])), [activeReferences]);
    const toneMap = useMemo(() => buildCanvasMentionToneMap(activeReferences), [activeReferences]);
    const activeLabels = useMemo(() => Array.from(new Set(activeReferences.map((item) => item.label))).sort((a, b) => b.length - a.length), [activeReferences]);
    const tokens = useMemo(() => parseTokens(value, activeLabels), [value, activeLabels]);

    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        if (!query) return activeReferences;
        return activeReferences.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(query));
    }, [mention, activeReferences]);

    const renderTokensToEditor = (nextTokens: Token[]) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        nextTokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const reference = (token.nodeId ? referenceByNodeId.get(token.nodeId) : undefined) || (token.label ? referenceByLabel.get(token.label) : undefined);
            if (reference) editor.append(createReferenceChip(reference, setImagePreview, toneMap));
            else editor.append(document.createTextNode(token.raw));
        });
    };

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        if (document.activeElement === editor && value === lastEmittedRef.current) return;
        renderTokensToEditor(tokens);
        lastEmittedRef.current = value;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokens, referenceByLabel, referenceByNodeId, toneMap, value]);

    const emit = (next: string) => {
        if (next === lastEmittedRef.current) return;
        if (!applyingHistoryRef.current) {
            undoStackRef.current.push(lastEmittedRef.current);
            if (undoStackRef.current.length > 200) undoStackRef.current.shift();
            redoStackRef.current = [];
        }
        lastEmittedRef.current = next;
        onChange(next);
    };

    const applyHistoryValue = (next: string) => {
        applyingHistoryRef.current = true;
        lastEmittedRef.current = next;
        renderTokensToEditor(parseTokens(next, activeLabels));
        onChange(next);
        placeCaretAtEnd(editorRef.current);
        captureSelection();
        applyingHistoryRef.current = false;
        closeMention();
    };

    const undo = () => {
        const prev = undoStackRef.current.pop();
        if (prev === undefined) return false;
        redoStackRef.current.push(lastEmittedRef.current);
        applyHistoryValue(prev);
        return true;
    };

    const redo = () => {
        const next = redoStackRef.current.pop();
        if (next === undefined) return false;
        undoStackRef.current.push(lastEmittedRef.current);
        applyHistoryValue(next);
        return true;
    };

    const syncFromEditor = () => {
        if (composingRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        emit(serializeEditor(editor, stableNodeMentions));
        syncMention();
        captureSelection();
    };

    const captureSelection = () => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        if (!editor || !selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) return;
        savedRangeRef.current = range.cloneRange();
    };

    const syncMention = () => {
        const text = textBeforeCaretInTextNode();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || !activeReferences.length) {
            closeMention();
            return;
        }
        setMention({ query: match[1] || "", rect: caretRect() });
        setActiveIndex(0);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const restoreEditorSelection = () => {
        const editor = editorRef.current;
        if (!editor) return false;
        editor.focus();
        const selection = window.getSelection();
        const saved = savedRangeRef.current;
        if (saved && editor.contains(saved.commonAncestorContainer)) {
            const range = saved.cloneRange();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return true;
        }
        if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
            placeCaretAtEnd(editor);
        }
        return true;
    };

    const insertReference = (reference: CanvasResourceReference) => {
        const editor = editorRef.current;
        if (!editor || !restoreEditorSelection()) return;
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) {
            placeCaretAtEnd(editor);
        }
        const working = selection.getRangeAt(0);
        // 有选区：替换选中文字；仅光标：纯插入，不碰前后文字
        if (!working.collapsed) {
            working.deleteContents();
        } else {
            removeActiveMentionInTextNode(working);
        }
        const insertRange = selection.getRangeAt(0);
        insertRange.collapse(true);

        const chip = createReferenceChip(reference, setImagePreview, toneMap);
        const space = document.createTextNode(" ");
        const fragment = document.createDocumentFragment();
        fragment.append(chip, space);
        insertRange.insertNode(fragment);

        const caret = document.createRange();
        caret.setStartAfter(space);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
        savedRangeRef.current = caret.cloneRange();

        closeMention();
        emit(serializeEditor(editor, stableNodeMentions));
    };

    useImperativeHandle(ref, () => ({
        insertReference,
        focus: () => {
            void restoreEditorSelection();
        },
    }));

    const showReferenceHover = (event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ref-label]") : null;
        if (!target) {
            setReferenceHover(null);
            return;
        }
        const label = target.dataset.refLabel || "";
        const reference = referenceByLabel.get(label);
        if (!reference) {
            setReferenceHover(null);
            return;
        }
        const rect = target.getBoundingClientRect();
        const editorRect = editorRef.current?.getBoundingClientRect();
        if (!editorRect) return;
        setReferenceHover({
            reference,
            left: rect.left - editorRect.left,
            top: rect.top - editorRect.top,
            width: rect.width,
            height: rect.height,
        });
    };

    const showPlaceholder = !value.trim();

    return (
        <div className={`relative w-full ${containerClassName || ""}`}>
            {showPlaceholder && placeholder ? (
                <div className="pointer-events-none absolute left-3 top-2 text-sm leading-5" style={{ color: theme.node.placeholder }}>
                    {placeholder}
                </div>
            ) : null}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                className={`${className || ""} overflow-y-auto whitespace-pre-wrap break-words outline-none`}
                style={{ ...style, cursor: "text" }}
                onInput={syncFromEditor}
                onCut={() => requestAnimationFrame(syncFromEditor)}
                onPaste={() => requestAnimationFrame(syncFromEditor)}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={() => {
                    composingRef.current = false;
                    syncFromEditor();
                }}
                onMouseUp={captureSelection}
                onKeyUp={captureSelection}
                onSelect={captureSelection}
                onMouseOver={showReferenceHover}
                onMouseLeave={() => setReferenceHover(null)}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    event.stopPropagation();
                    if (isImeComposing(event)) return;
                    const mod = event.ctrlKey || event.metaKey;
                    if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) {
                        if (undo()) {
                            event.preventDefault();
                            return;
                        }
                    }
                    if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
                        if (redo()) {
                            event.preventDefault();
                            return;
                        }
                    }
                    if (mention && candidates.length) {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setActiveIndex((index) => (index + 1) % candidates.length);
                            return;
                        }
                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                            return;
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                            return;
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            closeMention();
                            return;
                        }
                    }
                    if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                        event.preventDefault();
                        requestAnimationFrame(syncFromEditor);
                        return;
                    }
                    if (isPlainEnterKey(event) && onSubmit) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    requestAnimationFrame(() => {
                        syncMention();
                        captureSelection();
                    });
                }}
                onBlur={() => window.setTimeout(closeMention, 120)}
            />
            {referenceHover ? (
                <Popover open placement="top" content={<AgentCanvasReferencePreview reference={referenceHover.reference} previewUrl={referenceHover.reference.previewUrl} previewText={referenceHover.reference.text} theme={theme} autoPlayMedia />}>
                    <span aria-hidden className="pointer-events-none absolute" style={{ left: referenceHover.left, top: referenceHover.top, width: referenceHover.width, height: referenceHover.height }} />
                </Popover>
            ) : null}
            {mention && candidates.length ? (
                <MentionMenu rect={mention.rect} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} />
            ) : null}
            {imagePreview ? <Image src={imagePreview} alt={i18n.t("canvas.composer.imagePreview")} style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );
});

function MentionMenu({ rect, references, activeIndex, theme, onSelect }: { rect: DOMRect | null; references: CanvasResourceReference[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (reference: CanvasResourceReference) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, references]);

    const selectReference = (reference: CanvasResourceReference) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(reference);
    };

    const stopCanvasInteraction = (event: PointerEvent | ReactMouseEvent) => event.stopPropagation();

    const menuWidth = 256;
    const maxMenuHeight = 224;
    const gap = 6;
    const anchor = rect || new DOMRect(16, 16, 0, 0);
    const left = clamp(anchor.left, 8, window.innerWidth - menuWidth - 8);
    const showAbove = anchor.bottom + gap + maxMenuHeight > window.innerHeight && anchor.top - gap - maxMenuHeight >= 0;
    const top = showAbove ? anchor.top - gap - maxMenuHeight : anchor.bottom + gap;

    return createPortal(
        <div
            data-canvas-resource-mention-menu="true"
            className="fixed z-[1100] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md"
            style={{ left, top, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            onClick={(event) => event.stopPropagation()}
        >
            {references.map((reference, index) => (
                <button
                    key={reference.id}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                >
                    <ReferencePreview reference={reference} />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{reference.text || reference.title || reference.label}</span>
                    </span>
                </button>
            ))}
        </div>,
        document.body,
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(reference: CanvasResourceReference, onImagePreview: (url: string) => void, toneMap?: Map<string, CanvasMentionTone>) {
    const key = canvasMentionKey(reference);
    const tone = canvasMentionTone(key, toneMap);
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.refLabel = reference.label;
    wrapper.dataset.refNodeId = reference.nodeId;
    wrapper.dataset.refKey = key;
    wrapper.className = "mx-0.5 inline-flex h-6 max-w-[9.5rem] items-center gap-1 overflow-hidden rounded-md border px-1 align-middle text-[11px] leading-none";
    wrapper.style.backgroundColor = tone.background;
    wrapper.style.borderColor = tone.border;
    wrapper.style.color = tone.text;
    wrapper.style.boxShadow = `0 0 0 1px ${tone.border}`;
    wrapper.title = reference.text || reference.title || reference.label;

    if ((reference.kind === "image" || reference.kind === "video") && reference.previewUrl) {
        if (reference.kind === "image") {
            const image = document.createElement("img");
            image.src = reference.previewUrl;
            image.alt = "";
            image.className = "size-4 shrink-0 rounded object-cover";
            wrapper.appendChild(image);
        } else {
            const video = document.createElement("video");
            video.src = reference.previewUrl;
            video.muted = true;
            video.preload = "metadata";
            video.className = "size-4 shrink-0 rounded object-cover";
            wrapper.appendChild(video);
        }
    } else {
        const icon = document.createElement("span");
        icon.className = "grid size-4 shrink-0 place-items-center";
        icon.textContent = reference.kind === "audio" ? "♪" : reference.kind === "text" ? "T" : "•";
        wrapper.appendChild(icon);
    }

    const text = document.createElement("span");
    text.className = "min-w-0 truncate";
    text.textContent = canvasMentionDisplayName(reference);
    wrapper.appendChild(text);

    wrapper.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (reference.kind === "image" && reference.previewUrl) onImagePreview(reference.previewUrl);
    });
    return wrapper;
}

function serializeEditor(editor: HTMLElement, stableNodeMentions: boolean) {
    return serializeNodes(editor.childNodes, stableNodeMentions).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>, stableNodeMentions: boolean) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const label = node.dataset.refLabel;
        const nodeId = node.dataset.refNodeId;
        if (label) result += stableNodeMentions && nodeId ? `@[node:${nodeId}]` : label;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes, stableNodeMentions);
    });
    return result;
}

/** 只在光标所在文本节点内删除未完成的 @mention，避免 toString 混入芯片文案后误删「电」等字符 */
function removeActiveMentionInTextNode(range: Range) {
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) return;
    const offset = range.startOffset;
    const text = (container.textContent || "").slice(0, offset);
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    const deleteCount = (match[1] || "").length + 1;
    const next = range.cloneRange();
    next.setStart(container, offset - deleteCount);
    next.setEnd(container, offset);
    next.deleteContents();
}

function textBeforeCaretInTextNode() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return "";
    return (range.startContainer.textContent || "").slice(0, range.startOffset);
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.refLabel ? current : null;
}

function caretRect(): DOMRect | null {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height || rect.left || rect.top) return rect;
    const editor = closestEditor(range.startContainer);
    return editor ? editor.getBoundingClientRect() : null;
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement | null) {
    if (!element) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function parseTokens(value: string, labels: string[]): Token[] {
    const parts = ["@\\[node:([^\\]]+)\\]", ...labels.map((label) => `(${escapeRegExp(label)})`)];
    if (parts.length === 1 && !value.includes("@[node:")) return value ? [{ type: "text", value }] : [];
    const pattern = new RegExp(parts.join("|"), "g");
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        const nodeId = match[1];
        tokens.push({ type: "reference", label: nodeId ? undefined : match[0], nodeId, raw: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}
