import type { ConversationStrategy } from "./strategy";
import styles from "../../styles/desktop.module.css";

export const webPlainConversationStrategy: ConversationStrategy = {
  name: "web-plain",
  render({ contentRef, segments, renderItem, empty, isLoadingOlderHistory }) {
    if (
      segments.historyMounted.length === 0 &&
      segments.liveHead.length === 0 &&
      !isLoadingOlderHistory
    ) {
      return empty;
    }

    return (
      <div
        className={styles.turnList}
        data-conversation-strategy="web-plain"
        ref={contentRef}
      >
        {isLoadingOlderHistory ? <HistoryLoadingSlot /> : null}
        {segments.historyMounted.map((item) => renderItem(item))}
        {segments.liveHead.map((item) => renderItem(item))}
      </div>
    );
  },
};

function HistoryLoadingSlot() {
  return <div className={styles.historyLoader}>加载中</div>;
}
