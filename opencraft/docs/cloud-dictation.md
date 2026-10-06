# Web 混元听写

Web 的设置 → 通用 → 语音输入可选择自动、混元语音或浏览器语音。
自动模式仅在后台服务和当前浏览器录音能力均就绪时选择混元；显式选择混元不会在失败后偷偷切换服务。
Mac 系统听写保持原实现，本轮没有增加桌面云录音端口。

## 部署

配置后端进程的私有环境，不使用 `VITE_` 变量，不把真实值写入源码或日志：

- `OPENCRAFT_SPEECH_API_KEY`：服务端 TokenHub 凭据。缺失时服务不启用。
- `OPENCRAFT_SPEECH_MODEL`：缺省 `hy-asr-3.0-preview`；可配置已验证的专用模型别名。
- `OPENCRAFT_SPEECH_PUBLIC_ACCESS=1`：明确允许公网访问者使用此安装实例的付费语音服务；否则只允许 loopback-only 网关。它不继承 SSH 共享模式，不提供租户隔离或计费账本。

公网由 HTTPS 入口转发并保留公开 Host。转写 POST 要求匹配 Origin，无跨域通配或凭据透传。
配置密钥后仍需重启后端，并从设置刷新能力。`GET /__opencraft_speech/capabilities` 只报告公开能力和限制；
`POST /__opencraft_speech/transcribe` 接收 `audio/wav` 原始字节、会话/attempt 头和可选语种，不接受 URL、凭据或执行 Server。
Header/body 受后端校验；结果必须带匹配会话/attempt 身份。后端固定访问 TokenHub HTTPS 同步端点，不跟随重定向。

录音最多120秒；后端仅接受单声道16kHz PCM16 WAV，最大3,840,044字节，依据实际头与样本数计算时长。
上传最多15秒，上游识别最多90秒；同一实例最多2个上传/识别、每分钟最多10个新的付费尝试。
客户端不自动重试付费请求。重复attempt绑定音频摘要和语种，五分钟内返回缓存回执，最多64份；
进程重启不保证回执持久化，也不宣称供应商支持幂等提交。

## 生命周期

录音器收齐停止事件后转换音频，并立即释放麦克风。采集启动超时、权限拒绝、设备中断或录音时页面进入后台均失败，不自动插入部分文本。
服务失败可原位重试同一段临时音频，最多两次，等待重试两分钟后释放。成功、取消、草稿/View更换或扩展销毁后释放；音频不进入会话附件、历史、数据库或日志。
失败使旧发送意图失效；点击重试只允许写入，不会自动发送。取消立即撤销写入资格并中断本地请求，不保证上游停止计费。

## 验证与边界

```sh
npm run test:hunyuan-speech
npm run test:native-speech
npm run build:web
npm run smoke:hunyuan-dictation
```

浏览器 smoke 用真实录音/API/Composer和共享设置控件，仅麦克风设备与付费供应商替身。
覆盖宽屏/触屏、浅深主题、停止插入、失败重试不发送、取消和换草稿后的迟到结果。
真机权限、iPhone编码兼容、嵌入页麦克风授权、识别质量/耗时/费用仍须单独验收，合成测试不能证明。
官方契约：[同步识别](https://cloud.tencent.com/document/product/1823/135791)、[异步识别](https://cloud.tencent.com/document/product/1823/135792)。本实现不提供长录音异步任务或实时语音对话。
