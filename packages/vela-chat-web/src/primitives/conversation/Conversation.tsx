import type { ReactNode } from "react";
import styles from "../../styles/desktop.module.css";

export function Conversation({
  children,
  scrollRef,
}: {
  children: ReactNode;
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <section
      aria-label="Chat transcript"
      className={styles.conversation}
      ref={scrollRef}
    >
      {children}
    </section>
  );
}
