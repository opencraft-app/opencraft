"use client";

import styles from "../../styles/desktop.module.css";

export function ConversationHistoryHydrationView() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading conversation history"
      className={styles.historyHydration}
    >
      <div aria-hidden="true" className={styles.historyHydrationSpinner} />
      <div className={styles.historyHydrationLabel}>正在加载完整会话</div>
    </section>
  );
}
