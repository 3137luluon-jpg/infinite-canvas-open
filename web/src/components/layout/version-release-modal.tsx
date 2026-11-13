import type { CSSProperties } from "react";

import { PUBLIC_RELEASES_URL, PUBLIC_RELEASE_VERSION } from "@/constant/public-release";

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    return (
        <a
            href={PUBLIC_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
            style={style}
            title="查看开源版发布记录"
        >
            {PUBLIC_RELEASE_VERSION}
        </a>
    );
}
