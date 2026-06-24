import { VelaNextChat } from "../../packages/vela-chat-next/src";
import styles from "./page.module.css";

interface NextEmbedDemoProps {
  baseUrl?: string;
  sessionId?: string;
}

export function NextEmbedDemo({ baseUrl, sessionId }: NextEmbedDemoProps) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Next.js host shell</p>
          <h1 className={styles.title}>Embedded Vela Chat</h1>
        </div>
        <code className={styles.endpoint}>{baseUrl ?? "same-origin velad proxy"}</code>
      </header>

      <section className={styles.panel} aria-label="Embedded Vela Chat">
        {sessionId ? (
          <VelaNextChat
            baseUrl={baseUrl}
            hostId="next-embed-demo"
            sessionId={sessionId}
          />
        ) : (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No session selected</p>
            <p className={styles.emptyText}>
              Add <code>?session_id=&lt;session_id&gt;</code> to embed an existing
              velad session.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
