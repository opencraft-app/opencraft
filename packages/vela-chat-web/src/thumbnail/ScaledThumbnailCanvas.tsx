import type { ReactNode } from "react";
import styles from "./thumbnail.module.css";

export interface ScaledThumbnailCanvasProps {
  children: ReactNode;
  canvasHeight?: number;
  canvasWidth?: number;
  className?: string;
  scale?: number;
}

export function ScaledThumbnailCanvas({
  children,
  canvasHeight = 520,
  canvasWidth = 840,
  className,
  scale = 0.5,
}: ScaledThumbnailCanvasProps) {
  return (
    <div
      className={[styles.scaledViewport, className].filter(Boolean).join(" ")}
      style={{
        height: `${canvasHeight * scale}px`,
        width: `${canvasWidth * scale}px`,
      }}
    >
      <div
        className={styles.scaledCanvas}
        style={{
          height: `${canvasHeight}px`,
          transform: `scale(${scale})`,
          width: `${canvasWidth}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
