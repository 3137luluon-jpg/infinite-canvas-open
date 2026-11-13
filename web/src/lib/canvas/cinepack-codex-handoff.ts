export const CINEPACK_CODEX_TASK_PARAM = "cinepackCodexTask";
export const CINEPACK_IMPORT_ORGANIZE_TASK_ID = "import-organize";
export const CINEPACK_COMPILE_VIDEO_PROMPTS_TASK_ID = "compile-video-prompts";
export const CINEPACK_SEEDANCE_SKILL = "seedance20-video-promptsV2.3";
export const CINEPACK_CANVAS_SKILL = "cinepack-canvas";
export const CINEPACK_H3_SKILL = "h3-prompt-writing";
export const CINEPACK_PROMPT_PROFILES = {
    h3: { label: "MiniMax H3", skill: CINEPACK_H3_SKILL },
    seedance20: { label: "Seedance 2.0", skill: CINEPACK_SEEDANCE_SKILL },
} as const;
export type CinePackPromptProfile = keyof typeof CINEPACK_PROMPT_PROFILES;

export function cinePackCompileInstruction(profile: CinePackPromptProfile = "h3") {
    const selected = CINEPACK_PROMPT_PROFILES[profile];
    const format = profile === "h3"
        ? "使用 H3 Skill 的输入模式、素材映射、对白与声音规则。预览逐镜交付完整中文核对版和英文使用版，应用时只把英文使用版写入视频节点，中文对白保留原文。不套用 Seedance 字数或时长限制。故事板仅为可选构图参考，不能把宫格当成视频首帧；不得因没有故事板阻止编译。按真实素材用途区分身份、造型、场景与首尾帧，入口未核验时标记待验证，不能承诺严格首帧对齐。"
        : "按用户明确选择的 Seedance 2.0 Skill 编译；不得把该 Skill 的 V2.3 版本号解释为 Seedance 2.5。";
    return `$${selected.skill}\n目标提示词：${selected.label}。${format} 按现有 metadata.cinepack.shotGroupId 编译，读取项目、风格、剧本、导演分镜、镜头说明及资产；有选区时仅处理所属组，否则处理全部已有组。禁止重新分组、合并或拆镜。只更新 kind=shot 视频节点的 metadata.prompt 与 metadata.composerContent，二者必须相同。保留现有 @[node:] 引用及首次出现顺序，核对 variantBindings 对应的实际 Look。不得修改 locked 源事实或写本地 md，不调用 canvas_run_generation。此选择只切换提示词 Skill，不切换视频节点的生成模型。`;
}

type CanvasSkillRef = { name: string; path?: string; enabled?: boolean };

/** 识别裸名、插件命名空间名，以及目录仍为原 Skill 名的路径。 */
export function canvasSkillMatches(skill: CanvasSkillRef, expectedName: string) {
    const actual = skill.name.trim().toLowerCase();
    const expected = expectedName.trim().toLowerCase();
    if (!expected) return false;
    if (actual === expected || actual.endsWith(`:${expected}`)) return true;
    const normalizedPath = (skill.path || "").replace(/\\/g, "/").toLowerCase();
    return normalizedPath.includes(`/${expected}/skill.md`);
}

/** 从 Codex Skill 列表中取出片场任务实际要绑定的技能。 */
export function findCanvasSkill<T extends CanvasSkillRef>(skills: T[], expectedName: string, requireEnabled = true): T | null {
    return skills.find((item) => (!requireEnabled || item.enabled) && canvasSkillMatches(item, expectedName)) || null;
}
