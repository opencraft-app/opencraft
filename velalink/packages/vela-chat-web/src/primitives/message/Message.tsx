import type { ReactNode } from "react";
import styles from "../../styles/desktop.module.css";

export function Message({
  from,
  children,
}: {
  from: "user" | "assistant" | "system";
  children: ReactNode;
}) {
  return (
    <div className={from === "user" ? styles.messageUser : styles.messageAssistant}>
      {children}
    </div>
  );
}
