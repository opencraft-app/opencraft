# 进度

已读取维护、TDD、UI/无障碍、图标与React性能规范。原生Speech旧预览19828继续保持；本次不录音。

已实施：呈现附着瞬时输入事务、草稿/View置换同步释放；真实数值音量事件（原生≤20Hz）不发布草稿snapshot；专用原位Footer、时长、停止写入/等待最终再发送、Escape/150ms长按。
红绿：旧事务/Footer归属、原生数值音量校验、完成只停止一次且取消胜过迟到完成、长按释放不触发再次点击、物理View替换不继承旧mode。聚焦测试通过。
旧根gate完成，CodexComposer/voice类型及universalSwift构建通过；签名隔离桌面场景正在验证。图标CLI未安装，采用项目已有lucide入口，不另引图标库。

桌面准备失败：第一轮还在设置页面，后续用原始model ID匹配Composer展示名失败。冷目录RPC实际1项/1默认，UI title为正确dictation-fixture；源码compactModelLabel会把连字符折叠为空格。之前“未热刷新”判断被此证据推翻，不能声称缓存故障；测试改匹配原始语义title。冷启动保留为隔离配置准备，不扩目录服务。
多次失败后已更新checkpoint并检查真实RPC/title而非重复同一等待。语音无模型probe/事务桌面独立验收通过，不冒充发送验收。

实际客户端：取消/写入/编辑器identity通过；Enter正文推理实际一次，另有DSH独立title推理（不同system/user结构），测试按正文语义统计而非把标题当重复发送。明暗必须走Appearance设置，CDP系统模拟不会覆盖显式主题偏好。
重复长按验收发现真实release丢失：触发按钮因标准区inert失去事件。新增pointerId归属红绿测试，手势在Window capture层持有释放/取消与blur监听，按钮只提供入口；取消/卸载清理。26项聚焦通过，最终产物重建复验中。
根catalog检查发现本Task Pack两项新增格式问题（triggers不足3、source_of_truth内联被轻量parser识别为字符串），已改三项trigger与显式block array；不得混入历史baseline声称通过。
最终产物strict deep codesign及native helper strict校验通过；smoke:dictation-interaction、smoke:native-speech均退出0。应用实际Dark/Light截图已检查（不是模拟system偏好）。文档/正式设计映射/diff检查通过，33项context-audit测试通过；最终catalog已无本Task新增命中，历史schema/英文/budget/hex扫描仍存在。
证据：/tmp/opencraft-dictation-{desktop-final,probe-desktop-final,focused,gate-final,context-final}.log；/tmp/opencraft-dictation-{dark,light}.png。手势释放修复后26聚焦通过，最终gate收尾。
交接：最终完整npm gate退出0，26聚焦、签名helper/bundle、无录音原生probe与合成实机UI/本地正文请求验收通过。根context最终26测试4项历史失败（本Task格式已修正且无新增命中），33项audit测试通过；未扩大清理历史。
新预览已启动最终产物并回Chat，未录音/未复制认证/未提交推送，旧预览未覆盖或终止。真实语音与端侧识别本轮未复验；不声称与恢复源码/官方发行100%类体或像素相同。
