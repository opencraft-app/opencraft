# 听写写入所有权闭环

目标：落实具体controller回调、appendText/getText同步闭环与追加文末语义，保持Store/View分离。
非目标：不扩录音历史/重试UI，不改DSH/认证，不自动录音、不提交推送，不覆盖旧预览。

1. 写入契约 — appendText默认文末，getText读取同一View，异步录音request绑定当时handlers，重试/cleanup使用具体request身份。
2. 内容替换失效/原View写入回执/拒绝不发送 — 完成，TDD。
3. 真实组件：非文末选区不会被听写替换，原内容替换/编辑器状态重建无旧结果复活 — 完成。
4. 类型/测试/gate、独立签名客户端和新预览 — 完成；实际语音未录音。

验收：36聚焦、完整npm gate、真实Core/OpenCraftComposer/Voice组件（ASR边界替身）与独立签名桌面正常链路通过。新产物release/dictation-owner-20260915；旧预览保持，不复制认证，不提交推送。
边界：controller绑定、同步写后读与追加文末；boolean ack与Draft/View/contentEpoch维持Store/View分离。

无路由匹配，有界源码精确检索。缺失查询composer-action-renderers.test.tsx停止，使用既有core与签名桌面脚本。
