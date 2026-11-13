import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";

// 本地定制：界面固定简体中文，不再提供切换入口；清掉历史语言偏好以免仍显示英文
try {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
} catch {
    // ignore
}

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
    },
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

/** 本地已隐藏语言切换；保留函数以免旧引用报错，实际始终切回中文 */
export function changeAppLocale(_locale: AppLocale) {
    try {
        localStorage.removeItem(LOCALE_STORAGE_KEY);
    } catch {
        // ignore
    }
    return i18n.changeLanguage("zh-CN");
}

export default i18n;
