import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Shortcut = { keys: string[]; label: string };

export function CanvasShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sections: Array<{ title: string; shortcuts: Shortcut[] }> = [
        {
            title: t("canvas.shortcut.navigation"),
            shortcuts: [
                { keys: [t("canvas.shortcut.dragCanvas")], label: t("canvas.shortcut.pan") },
                { keys: [t("canvas.shortcut.middleDrag")], label: t("canvas.shortcut.pan") },
                { keys: [t("canvas.shortcut.wheel")], label: t("canvas.shortcut.zoom") },
                { keys: ["Ctrl / Space", t("canvas.shortcut.dragCanvas")], label: t("canvas.shortcut.boxSelect") },
            ],
        },
        {
            title: t("canvas.shortcut.selectionEditing"),
            shortcuts: [
                { keys: [t("canvas.shortcut.clickNode")], label: t("canvas.shortcut.selectNode") },
                { keys: ["Shift / Ctrl / Cmd", t("canvas.shortcut.clickNode")], label: t("canvas.shortcut.addSelection") },
                { keys: [t("canvas.shortcut.dragNode")], label: t("canvas.shortcut.moveNode") },
                { keys: ["Alt", t("canvas.shortcut.dragNode")], label: t("canvas.shortcut.altDragDuplicate") },
                { keys: [t("canvas.shortcut.clickText")], label: t("canvas.shortcut.editText") },
                { keys: [t("canvas.shortcut.doubleClickTitle")], label: t("canvas.shortcut.renameNode") },
                { keys: [t("canvas.shortcut.dragHandle")], label: t("canvas.shortcut.connectNode") },
            ],
        },
        {
            title: t("canvas.shortcut.keyboard"),
            shortcuts: [
                { keys: ["Ctrl / Cmd", "A"], label: t("canvas.shortcut.selectAll") },
                { keys: ["Ctrl / Cmd", "C / V"], label: t("canvas.shortcut.copyPaste") },
                { keys: ["Ctrl / Cmd", "D"], label: t("canvas.shortcut.duplicate") },
                { keys: ["Ctrl / Cmd", "G"], label: t("canvas.shortcut.group") },
                { keys: ["Ctrl / Cmd", "Shift", "G"], label: t("canvas.shortcut.ungroup") },
                { keys: ["Enter"], label: t("canvas.shortcut.editText") },
                { keys: ["F2"], label: t("canvas.shortcut.renameNode") },
                { keys: ["↑ / ↓ / ← / →"], label: t("canvas.shortcut.nudge") },
                { keys: ["Shift", "↑ / ↓ / ← / →"], label: t("canvas.shortcut.nudgeFast") },
                { keys: ["F"], label: t("canvas.shortcut.focusSelection") },
                { keys: ["Shift", "F"], label: t("canvas.shortcut.fitCanvas") },
                { keys: ["0"], label: t("canvas.shortcut.resetZoom") },
                { keys: ["Ctrl / Cmd", "Z / Shift+Z / Y"], label: t("canvas.shortcut.undoRedo") },
                { keys: ["Delete / Backspace"], label: t("canvas.shortcut.delete") },
                { keys: ["Esc"], label: t("canvas.shortcut.escape") },
            ],
        },
    ];

    return (
        <Modal title={t("canvas.shortcuts")} open={open} onCancel={onClose} footer={null} centered width={680}>
            <div className="max-h-[70vh] space-y-5 overflow-y-auto border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                {sections.map((section) => (
                    <section key={section.title}>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-45">{section.title}</h3>
                        <div className="space-y-1">
                            {section.shortcuts.map((shortcut) => (
                                <ShortcutRow key={`${section.title}-${shortcut.keys.join("-")}`} {...shortcut} />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </Modal>
    );
}

function ShortcutRow({ keys, label }: Shortcut) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_180px] items-center gap-4 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd className="min-w-9 rounded-md border border-stone-300/60 bg-stone-50 px-2.5 py-1.5 text-center text-xs font-medium leading-none text-stone-700 shadow-sm">{key}</kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{label}</span>
        </div>
    );
}
