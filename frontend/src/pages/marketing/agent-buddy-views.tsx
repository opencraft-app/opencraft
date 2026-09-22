import { useEffect, useRef, useState, type ReactNode } from "react";

/** Scales the fixed-coordinate persona draw stage to the dialog's available width. */
export function PersonaDrawStageView({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateScale = () => {
      const availableWidth = stage.getBoundingClientRect().width;
      if (availableWidth > 0) setScale(Math.min(1, availableWidth / width));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={stageRef} className="w-full" style={{ maxWidth: width, height: height * scale }}>
      <div className="relative origin-top-left" style={{ width, height, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
