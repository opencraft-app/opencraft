/**
 * 文档页右侧"本页目录"。监听 h2/h3 的滚动位置，高亮当前段。
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface TocProps {
  items: TocItem[];
}

export function DocsToc({ items }: TocProps) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    if (items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      {
        // 上边距给 sticky 顶栏留空间，下边距压大些，让标题进入视口顶部就高亮
        rootMargin: "-80px 0px -70% 0px",
        threshold: 0,
      },
    );

    items.forEach((item) => {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <aside className="hidden xl:block w-56 shrink-0 pl-8 py-8">
      <div className="sticky top-[76px]">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
          本页目录
        </h4>
        <ul className="space-y-1 text-sm border-l border-[var(--border-subtle)]">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={cn(
                  "block pl-3 py-1 -ml-px border-l transition-colors",
                  activeId === item.id
                    ? "border-[var(--text-primary)] text-[var(--text-primary)] font-medium"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                {item.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
