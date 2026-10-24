import { createContext, useContext, type ReactNode } from "react";

export type NativeChatLanguage = "zh-CN" | "en";

const NativeChatLanguageContext = createContext<NativeChatLanguage>("en");

export function NativeChatLanguageProvider({ children, language }: {
  readonly children: ReactNode;
  readonly language: NativeChatLanguage;
}) {
  return <NativeChatLanguageContext.Provider value={language}>{children}</NativeChatLanguageContext.Provider>;
}

export function useNativeChatCopy() {
  const language = useContext(NativeChatLanguageContext);
  return language === "zh-CN" ? {
    link: "链接",
    linkActions: "长按可操作链接",
    openInBrowser: "在浏览器中打开",
    copyLink: "复制链接",
    cancel: "取消",
    previewImage: "预览图片",
    closeImagePreview: "关闭图片预览",
    previousImage: "上一张图片",
    nextImage: "下一张图片",
    openDiagram: "查看图表",
    showDiagram: "查看图表",
    showDiagramSource: "查看图表源码",
    closeDiagram: "关闭图表",
    expandTable: "展开表格",
    closeTablePreview: "关闭表格预览",
    tablePreview: "表格预览",
    copyTable: "复制表格",
    copiedTable: "已复制表格",
  } : {
    link: "Link",
    linkActions: "Long press for link actions",
    openInBrowser: "Open in browser",
    copyLink: "Copy link",
    cancel: "Cancel",
    previewImage: "Preview image",
    closeImagePreview: "Close image preview",
    previousImage: "Previous image",
    nextImage: "Next image",
    openDiagram: "Open diagram",
    showDiagram: "Show diagram",
    showDiagramSource: "Show diagram source",
    closeDiagram: "Close diagram",
    expandTable: "Expand table",
    closeTablePreview: "Close table preview",
    tablePreview: "Table preview",
    copyTable: "Copy table",
    copiedTable: "Copied table",
  };
}
