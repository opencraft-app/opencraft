import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

export interface ListboxNavigationOptions {
  isOpen: boolean;
  itemCount: number;
  selectedIndex: number;
  onClose: () => void;
  onSelectIndex: (index: number) => void;
  onOpen?: () => void;
}

export function useListboxNavigation({
  isOpen,
  itemCount,
  onClose,
  onOpen,
  onSelectIndex,
  selectedIndex,
}: ListboxNavigationOptions) {
  const initialIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  useEffect(() => {
    if (isOpen) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [isOpen, selectedIndex]);

  const move = useCallback(
    (delta: number) => {
      if (itemCount <= 0) return;
      setActiveIndex((current) => (current + delta + itemCount) % itemCount);
    },
    [itemCount],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (itemCount <= 0) return;
      if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        onOpen?.();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(itemCount - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        if (!isOpen) return;
        event.preventDefault();
        onSelectIndex(activeIndex);
      } else if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        onClose();
      }
    },
    [activeIndex, isOpen, itemCount, move, onClose, onOpen, onSelectIndex],
  );

  return { activeIndex, onKeyDown, setActiveIndex };
}

