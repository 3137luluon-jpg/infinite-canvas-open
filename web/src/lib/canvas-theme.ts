export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f2ed",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#1c1917",
            selectionFill: "rgba(28,25,23,.06)",
            groupBackground: "rgba(251,250,247,.42)",
            groupInnerBackground: "rgba(231,229,223,.34)",
            groupInnerBorder: "rgba(120,113,108,.34)",
        },
        node: {
            label: "#57534e",
            fill: "#e7e5df",
            panel: "#fbfaf7",
            stroke: "#d6d3ca",
            activeStroke: "#1c1917",
            placeholder: "#8a8479",
            text: "#292524",
            body: "#44403c",
            muted: "#78716c",
            faint: "#a8a29e",
        },
        toolbar: {
            panel: "rgba(251,250,247,.96)",
            border: "#d6d3ca",
            item: "#57534e",
            itemHover: "#e7e5df",
            activeBg: "#e7e5df",
            activeText: "#292524",
        },
    },
    dark: {
        canvas: {
            background: "#17191d",
            dot: "rgba(221,226,234,.16)",
            line: "rgba(221,226,234,.07)",
            selectionStroke: "#8caeff",
            selectionFill: "rgba(79,140,255,.10)",
            groupBackground: "rgba(31,34,39,.62)",
            groupInnerBackground: "rgba(38,41,47,.46)",
            groupInnerBorder: "rgba(163,170,181,.18)",
        },
        node: {
            label: "#c7ccd4",
            fill: "#25282e",
            panel: "#202328",
            stroke: "#3a3f47",
            activeStroke: "#e7eaf0",
            placeholder: "#858c97",
            text: "#e1e4e9",
            body: "#c3c8d0",
            muted: "#a5abb5",
            faint: "#686f79",
        },
        toolbar: {
            panel: "rgba(32,35,40,.96)",
            border: "#3a3f47",
            item: "#b7bdc7",
            itemHover: "#2b2f36",
            activeBg: "#303640",
            activeText: "#edf0f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
