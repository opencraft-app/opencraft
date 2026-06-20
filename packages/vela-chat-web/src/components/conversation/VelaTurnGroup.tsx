import { memo } from "react";
import type { ConversationStreamItem } from "../../conversation-runtime/model";
import { renderWebBlock } from "../../renderers/blockRegistry";
import styles from "../../styles/desktop.module.css";

export const VelaTurnGroup = memo(function VelaTurnGroup({
  item,
}: {
  item: ConversationStreamItem;
}) {
  return (
    <article
      className={styles.turnGroup}
      data-continuation={item.continuation ? "true" : undefined}
      data-activity-id={item.sourceActivityId}
      data-turn-id={item.sourceTurnId}
      data-turn-kind={item.kind}
    >
      <div className={styles.turnBlock}>{renderWebBlock(item.block)}</div>
    </article>
  );
});
