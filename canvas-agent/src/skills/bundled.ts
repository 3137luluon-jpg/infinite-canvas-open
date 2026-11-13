import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../utils/logger.js";

const SKILL_ENTRY = "SKILL.md";

/** 解析仓库或包内 Infinite Canvas 插件 Skills 目录。 */
export function resolvePluginSkillsRoot(): string | undefined {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const agentRoot = path.resolve(here, "..", "..");
    const candidates = [
        path.join(agentRoot, "bundled-skills"),
        path.join(agentRoot, "..", "plugins", "infinite-canvas", "skills"),
    ];
    return candidates.find((directory) => fs.existsSync(path.join(directory, "cinepack-canvas", SKILL_ENTRY)));
}

/** 把插件 Skills 同步到站点工作空间 `.agents/skills`，供 Codex `skills/list` 按 cwd 发现。 */
export function syncBundledPluginSkills(workspacePath: string, sourceRoot = resolvePluginSkillsRoot()) {
    if (!sourceRoot) {
        logger.warn("Bundled Infinite Canvas plugin skills were not found next to Canvas Agent");
        return [];
    }
    const destRoot = path.join(path.resolve(workspacePath), ".agents", "skills");
    try {
        fs.mkdirSync(destRoot, { recursive: true });
    } catch (error) {
        logger.warn("Failed to create Canvas Agent skills directory", { destRoot, error });
        return [];
    }
    const copied: string[] = [];
    for (const name of listSkillDirectories(sourceRoot)) {
        if (copySkillDirectory(path.join(sourceRoot, name), path.join(destRoot, name))) copied.push(name);
    }
    if (copied.length) logger.info("Synced bundled plugin skills into Canvas Agent workspace", { sourceRoot, destRoot, skills: copied });
    return copied;
}

function listSkillDirectories(sourceRoot: string) {
    try {
        return fs.readdirSync(sourceRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(sourceRoot, entry.name, SKILL_ENTRY)))
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        logger.warn("Failed to read bundled plugin skills", { sourceRoot, error });
        return [];
    }
}

function copySkillDirectory(sourceDir: string, destDir: string) {
    try {
        const destination = fs.existsSync(destDir) ? fs.lstatSync(destDir) : undefined;
        if (destination?.isSymbolicLink()) {
            logger.warn("Skipped bundled skill because the destination is a symlink", { destDir });
            return false;
        }
        if (destination) fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(destDir, "agents"), { recursive: true });
        fs.copyFileSync(path.join(sourceDir, SKILL_ENTRY), path.join(destDir, SKILL_ENTRY));
        const openAiSource = path.join(sourceDir, "agents", "openai.yaml");
        if (fs.existsSync(openAiSource)) fs.copyFileSync(openAiSource, path.join(destDir, "agents", "openai.yaml"));
        const references = path.join(sourceDir, "references");
        if (fs.existsSync(references)) fs.cpSync(references, path.join(destDir, "references"), { recursive: true });
        return fs.existsSync(path.join(destDir, SKILL_ENTRY));
    } catch (error) {
        logger.warn("Failed to sync bundled plugin skill", { sourceDir, destDir, error });
        return false;
    }
}
