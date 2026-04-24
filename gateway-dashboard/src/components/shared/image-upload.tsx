"use client";

import { useState, useRef, useCallback } from "react";
import { Link2, X, ImageIcon, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ImageSource {
  id: string;
  type: "base64" | "url";
  /** type=url 时为原始 URL；type=base64 时为 data:image/xxx;base64,xxxxx */
  data: string;
  /** 原始文件名（仅 base64 有） */
  filename?: string;
}

/** 将 File 对象转为 ImageSource */
export async function fileToImageSource(file: File): Promise<ImageSource> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        type: "base64",
        data: reader.result as string,
        filename: file.name,
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** 将 URL 转为 ImageSource */
export function urlToImageSource(url: string): ImageSource {
  return {
    id: crypto.randomUUID(),
    type: "url",
    data: url,
  };
}

/** 转换 ImageSource 为 OpenAI content block 数组 */
export function toOpenAIContent(images: ImageSource[], text: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // 文本块
  if (text) {
    blocks.push({ type: "text", text });
  }

  // 图片块
  for (const img of images) {
    if (img.type === "url") {
      blocks.push({
        type: "image_url",
        image_url: { url: img.data, detail: "auto" },
      });
    } else {
      blocks.push({
        type: "image_url",
        image_url: { url: img.data, detail: "auto" },
      });
    }
  }

  return blocks;
}

/** 转换 ImageSource 为 Anthropic content block 数组 */
export function toAnthropicContent(
  images: ImageSource[],
  text: string
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // 文本块
  if (text) {
    blocks.push({ type: "text", text });
  }

  // 图片块
  for (const img of images) {
    if (img.type === "base64") {
      // 解析 media_type: data:image/jpeg;base64,xxxxx → image/jpeg
      const match = img.data.match(/^data:([^;]+);base64,/);
      const mediaType = match ? match[1] : "image/jpeg";
      const base64Data = img.data.replace(/^data:[^;]+;base64,/, "");
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64Data,
        },
      });
    } else {
      // Anthropic 不直接支持 URL 图片，需转换为 base64（异步）
      // 这里先存一个占位，在请求构建时处理
      blocks.push({
        type: "image",
        source: {
          type: "url",
          url: img.data,
        },
      });
    }
  }

  return blocks;
}

/** 转换 ImageSource 为 Gemini inlineData parts */
export function toGeminiParts(
  images: ImageSource[],
  text: string
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];

  // 文本块
  if (text) {
    parts.push({ text });
  }

  // 图片块（仅支持 base64）
  for (const img of images) {
    if (img.type === "base64") {
      const match = img.data.match(/^data:([^;]+);base64,/);
      const mimeType = match ? match[1] : "image/jpeg";
      const base64Data = img.data.replace(/^data:[^;]+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType,
          data: base64Data,
        },
      });
    } else {
      // Gemini 不支持 URL 图片，添加文本引用
      parts.push({
        text: `[Image from URL: ${img.data}]`,
      });
    }
  }

  return parts;
}

interface ImageUploadProps {
  images: ImageSource[];
  onChange: (images: ImageSource[]) => void;
  maxImages?: number;
  disabled?: boolean;
}

export function ImageUpload({
  images,
  onChange,
  maxImages = 10,
  disabled = false,
}: ImageUploadProps) {
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);

  // 添加图片
  const addImages = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      const fileArr = Array.from(files);
      const remaining = maxImages - images.length;
      if (fileArr.length > remaining) {
        setError(`最多只能添加 ${maxImages} 张图片`);
        return;
      }

      const newSources: ImageSource[] = [];
      for (const file of fileArr) {
        if (!file.type.startsWith("image/")) {
          setError(`"${file.name}" 不是图片文件`);
          continue;
        }
        // 限制 10MB
        if (file.size > 10 * 1024 * 1024) {
          setError(`"${file.name}" 超过 10MB 限制`);
          continue;
        }
        try {
          newSources.push(await fileToImageSource(file));
        } catch {
          setError(`读取 "${file.name}" 失败`);
        }
      }

      if (newSources.length > 0) {
        onChange([...images, ...newSources]);
      }
    },
    [images, maxImages, onChange]
  );

  // 移除图片
  const removeImage = useCallback(
    (id: string) => {
      onChange(images.filter((img) => img.id !== id));
    },
    [images, onChange]
  );

  // 文件选择
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addImages(e.target.files);
        e.target.value = "";
      }
    },
    [addImages]
  );

  // 拖拽
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        addImages(e.dataTransfer.files);
      }
    },
    [addImages]
  );

  // 粘贴
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages]
  );

  // URL 添加
  const handleAddUrl = useCallback(() => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      setError("请输入有效的 URL（以 http:// 或 https:// 开头）");
      return;
    }
    if (images.length >= maxImages) {
      setError(`最多只能添加 ${maxImages} 张图片`);
      return;
    }
    onChange([...images, urlToImageSource(trimmed)]);
    setUrlInput("");
    setShowUrlInput(false);
    setError(null);
  }, [urlInput, images, maxImages, onChange]);

  const canAdd = images.length < maxImages;

  return (
    <div className="space-y-3">
      {/* 已有图片预览 */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <div
              key={img.id}
              className="relative group rounded-md overflow-hidden border bg-muted"
              style={{ width: 72, height: 72 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.data}
                alt={img.filename || "image"}
                className="w-full h-full object-cover"
              />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute top-0.5 right-0.5 rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {img.type === "url" && (
                <div className="absolute bottom-0.5 left-0.5">
                  <Link2 className="h-3 w-3 text-white drop-shadow" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 粘贴区域 / 上传区 */}
      {!disabled && canAdd && (
        <div
          ref={pasteRef}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer transition-colors",
            isDragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50",
            disabled && "opacity-50 cursor-not-allowed pointer-events-none"
          )}
          style={{ minHeight: 80, padding: "12px 8px" }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-center leading-tight">
            <span className="font-medium">点击上传</span>
            {" · "}
            <span>拖拽</span>
            {" · "}
            <span>粘贴</span>
            <br />
            {canAdd ? `还能添加 ${maxImages - images.length} 张` : "已达上限"}
          </p>
        </div>
      )}

      {/* URL 输入 */}
      {!disabled && canAdd && (
        <div className="space-y-1.5">
          {showUrlInput ? (
            <div className="flex gap-2">
              <Input
                placeholder="https://example.com/image.jpg"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddUrl();
                  if (e.key === "Escape") setShowUrlInput(false);
                }}
                className="flex-1 h-8 text-xs"
              />
              <Button size="sm" variant="secondary" onClick={handleAddUrl} className="h-8 px-3">
                添加
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowUrlInput(false);
                  setError(null);
                }}
                className="h-8 px-2"
              >
                取消
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowUrlInput(true)}
              className="w-full h-8 text-xs gap-1.5"
            >
              <Link2 className="h-3.5 w-3.5" />
              添加图片 URL
            </Button>
          )}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="flex items-center gap-1.5 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 格式提示 */}
      {images.length === 0 && (
        <p className="text-xs text-muted-foreground">
          支持 JPEG、PNG、GIF、WebP，最大 10MB/张
        </p>
      )}
    </div>
  );
}
