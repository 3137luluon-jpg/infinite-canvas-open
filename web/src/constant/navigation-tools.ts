import { FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";
import { CineFlowMark } from "@/components/layout/cineflow-mark";

export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
        hidden: true,
    },
    {
        slug: "video",
        icon: Video,
        hidden: true,
    },
    {
        slug: "prompts",
        icon: FileText,
        hidden: true,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "studio",
        icon: Video,
    },
    {
        slug: "cineflow",
        icon: CineFlowMark,
    },
    {
        slug: "config",
        icon: Settings2,
        // 顶栏左侧入口隐藏：右上角 UserStatusActions 已有配置按钮
        hidden: true,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

/** 顶栏 / 移动端导航实际展示项（隐藏项路由仍可直达，但不做入口） */
export const visibleNavigationTools = navigationTools.filter((tool) => !("hidden" in tool && tool.hidden));
