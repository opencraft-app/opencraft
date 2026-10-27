import { useState } from "react";
import "./host-profile-storage-notice.scss";

export function HostProfileStorageNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return <aside className="host-profile-storage-notice" role="status">
    <p>本地连接配置暂时无法读取，已保存的配置会保留。当前可继续使用服务器连接。</p>
    <div>
      <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      <button type="button" onClick={() => setDismissed(true)}>知道了</button>
    </div>
  </aside>;
}
