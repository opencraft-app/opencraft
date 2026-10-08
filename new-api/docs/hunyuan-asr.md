# Hunyuan ASR（mono2 本地适配）

本地协议扩展，非上游 NewAPI 已发布能力。外部使用标准
`POST /v1/audio/transcriptions`（multipart `file`、`model`）；不改 servicegateway。

## 渠道配置

选“高级自定义”渠道（58），协议选择 **Hunyuan ASR**：

```json
{
  "advanced_routes": [{
    "incoming_path": "/v1/audio/transcriptions",
    "upstream_path": "/v1/wand/asrproxy/sync_transcribe",
    "converter": "openai_transcriptions_to_hunyuan_asr"
  }]
}
```

渠道 Base URL 为 `https://tokenhub.tencentmaas.com`，渠道 Key 按既有安全配置输入；
默认 Bearer 鉴权。按实际模型配置可用模型及模型映射，转换使用映射后的模型名。
不要把凭据写入示例或日志。现有模型价格配置仍需单独设置，音频费用沿既有转写
估算口径：向上取整的秒数 / 60 × 1000 prompt tokens；不代表供应商真实 token usage。

## 协议及限制

- JSON `model`、`data`（原始音频 Base64）、`voice_encode_format: "auto"`、可选
  `source`。不使用 `input_url`、COS 或磁盘，不做解码重编码或启动外部转码进程。
  发送前在已有 multipart 文件上验证时长再 rewind，避免额外完整音频副本；
  HTTP 上传按固定 24KiB/32KiB 缓冲增量生成 Base64，JSON 前后缀只包含小型元数据。
  不生成完整 Base64/JSON 正文、不启动编码 goroutine，根据音频大小计算 Content-Length。
  请求体和 multipart 缓冲仍保留；这不是浏览器到供应商的完全直通或零缓冲。
- [TokenHub 官方同步接口](https://cloud.tencent.com/document/product/1823/135791)
  明确列出 PCM/WAV/OGG/MP3 等，格式默认 auto；Base64 前至多 75MB、编码后
  至多 100MB、时长至多 30 分钟。这不是浏览器的录音格式支持表。
- NewAPI 沿既有纯 Go 计费时长解析器接受 WAV、MP3、OGG/Opus、MP4/M4A、
  FLAC、AAC、AIFF；容器可解析不等于上游已验证支持全部 codec。
  WebM/Opus 的纯内存时长解析已补齐，且短合成语音通过 TokenHub 实测。
  裸 PCM 缺少采样率/声道元数据不接受。其它新增格式未逐一进行供应商联调，
  不宣称任意容器、codec、浏览器版本全部兼容。
- `language` 可选 `zh`/`en`；`response_format` 可选 `json`（默认）/`text`。
  其它字段、多个文件、时间戳、prompt、流式输出均明确拒绝，避免静默丢失语义。
- 官方上游完成条件是 `status == "completed"` 且 `output.text` 为字符串；
  同时兼容现有 OpenCraft 集成使用的 `data` envelope，但不能用嵌套成功掩盖顶层失败。
  空字符串可以表示静音，不作为自动重试理由。
- 请求取消传播，整个上游操作上限 90 秒（全局更短 timeout 优先）；禁止重定向。
  响应上限 128KiB、文本上限 32,000 UTF-8 字节。
- 传输结果不明及不合法成功响应不自动重试；非 200 使用既有状态码策略，
  但供应商原始错误正文替换为固定安全信息，不记录音频/Base64。

协议来源为上述腾讯云官方文档及仓库 OpenCraft `opencraft/scripts/speech-transcription-service.mjs`。
OpenCraft 用 MediaRecorder 动态选择 WebM/Opus、MP4、OGG/Opus，再在浏览器内
解码并转为 PCM16 单声道 16kHz WAV。本次未改浏览器上传行为；直接上传 WebM
仍需客户端接入标准 multipart API 并单独进行真实浏览器端到端验证。

## WebM/Opus 时长和实测

`common/audio_webm.go` 使用 Apache-2.0 的 `at-wat/ebml-go v0.19.4` 做 EBML
有界解析，按块时间戳和 RFC 6716 的 Opus TOC 帧数/时长计算，支持缺省 Duration、
未知 Segment/Cluster 长度、lacing、CodecDelay、尾部 DiscardPadding。
只接收单一 mono/stereo Opus 音轨，不支持视频、多音轨或 Vorbis。
重叠/倒退时间线、非有限元数据、截断元素和无音频均拒绝；元数据 Duration
不作为低估计费的依据。全文件上限 128MiB、叶元素 1MiB、已知结构深度 8、
元素计数 100 万、时间线 24h；ASR 入口再执行供应商 75MB/30min 的较严限制。
生产解析不调用 ffmpeg/ffprobe，不转码，不开后台解析 goroutine，不创建临时文件。

2026-10-07 19:03 北京时间，使用约 2.979 秒、10,387 字节的合成英语 WebM/Opus，
经本补丁的 multipart 解析、Base64 auto 转换和标准响应映射，向配置的 TokenHub
`ep-hyasr3` 发出一次同步请求。上游 HTTP 200/completed，约 1.29 秒，识别出
“This is a speech recognition format test.”。音频通过内存/stdin 传递，未落盘，
未读取用户录音；未改生产渠道，也不代表客户端或生产公共入口已切换。

有界重现脚本 `scripts/asr-webm-live-smoke.mjs` 默认只做本地检查，显式 `--send`
才发送一次付费请求；凭据从已有 Model Services 文件读入内存，不放入命令行。
合成工具只用于测试样本生成，生产解析不依赖它们；普通测试/CI 自动跳过 live test。

## 内存预算与验证

所有标准转写上传在首次读取（含渠道选择前）就使用纯内存 BodyStorage；
multipart 文件也不溢写临时目录。其它接口保持原缓存策略。
`TRANSCRIPTION_MAX_CONCURRENT` 为每个 NewAPI 进程的转写并发上限，默认 4，
范围 1–64；满额返回 429/Retry-After，不先读取上传正文。
`MAX_REQUEST_BODY_MB` 继续限制路由前上传大小；必须按它和并发预算预留内存，
不能只用最终压缩音频大小计算。内存数据在请求结束后释放引用供 GC 回收，
不是操作系统级擦除或无 swap 的保证。

单测覆盖内存/磁盘分流、multipart 不落盘、模拟上游 HTTP、格式拒绝、响应上限、
安全错误、重定向与取消、并发准入。源码验证不等于生产发布或付费上游联调；
发布前还需验证部署路径、模型价格和 Pod 容量。

增量编码测试另覆盖 Base64 padding、细粒度读写、JSON 字段转义、定长 HTTP 上传、
取消/读取错误与关闭。1MiB/8MiB/32MiB 编码基准的额外分配均约 67KiB，
不包含已有上传/multipart，也不代表完整请求峰值。

2026-10-07 19:35 北京时间，追加授权一次相同短合成 WebM/Opus 的增量上传实测：
适配器确认使用拉取式请求体，Content-Length=13,926，上游 HTTP200/completed，
完整识别合成英语，测试约 1.29s。音频/凭据未落盘；不代表生产公共入口已发布。
