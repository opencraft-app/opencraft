# 进度

已读取TDD/维护及当前Core/View/voice完成逻辑；源事实先核对，不扩到音频handoff或录音恢复。旧预览保持，本次不录音。
红绿：replace-content后失效、旧结果不调用View；物理commit拒绝返回false/cancel:commit-rejected；写入期间reentrant内容替换令ack失败；原文存在时拒绝插入也不能createSubmitIntent。测试一处资源label预期错误改为验证原richDocument结构，而非猜纯文本表示。
实现：Core draftId/View/contentEpoch fences；物理boolean回执；dictation append政策仿Codex文末/空格/selection到末尾，同View同步读回doc验证；泛用selection政策保留。voice完成仅用applied ack授权发送，非空结果但插入失败显式错误。
聚焦与目标类型通过，完整gate/签名真实组件在准备。
最终：36项聚焦、完整npm gate退出0，smoke:dictation-ownership真实组件验证追加不覆盖旧selection、replace-content/late result、不完整View reservation/reentrant写入拒绝零发送通过。签名桌面smoke:dictation-interaction通过正常写入/长按/Enter最终后一次正文请求/取消/切页/明暗/窄窗。
文档/正式设计映射/diff检查通过；根context仍4项历史schema/英文/预算/hex扫描失败，本Task无新增命中；33项audit通过。新独立预览启动，未录音/提交推送，旧预览不热更新。
证据：/tmp/opencraft-owner-{focused,types,components,gate,package,desktop,context,docs}.log。音频handoff与真实Speech识别本轮不声称已验收或修复。
