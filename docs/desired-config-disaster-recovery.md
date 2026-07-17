# DesiredConfig 单文件灾备

生产环境的 Agent 导入、发布和验收步骤以
[`deploy/k8s/prod/bootstrap/DESIRED_CONFIG_PLAYBOOK.md`](../deploy/k8s/prod/bootstrap/DESIRED_CONFIG_PLAYBOOK.md)
为准。默认本地文件为 `deploy/k8s/prod/bootstrap/private/desired-config.json`，该路径已被 Git 忽略。

DesiredConfig 是 LLMGateway 的完整渠道灾备格式，用一个 JSON 文件保存：

- 黄金 Set 的全部渠道（包括人工禁用渠道），不受 100 条分页上限影响；
- 每个渠道的明文上游密钥；
- 渠道的多 Key 模式、自动禁用、标签、状态码映射和 provider 专属设置；
- 固定价格、倍率、表达式计费、工具价格和额度换算配置；
- 用户分组、`auto` 分组、可用分组和渠道亲和等路由配置；
- 免费模型预扣、重试和渠道自动停用等运行策略；
- 渠道模板的名称和描述。

它与日常渠道模板不同。普通渠道 API、版本历史和管理台预览只展示密钥指纹；DesiredConfig 为了能够在全新环境独立恢复，明确包含明文密钥，必须按生产 Secret 管理，禁止写入 Git、工单、聊天记录或普通日志。

## 从黄金 Set 导出

管理台进入“渠道”，选择黄金集群、模板编号和名称，点击“下载完整备份”。也可以调用：

```bash
curl -fsS https://CONTROL_HOST/api/desired-config/export \
  -H "Authorization: Bearer $LLMGATEWAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source_set_id": "golden-set",
    "id": "golden-channels",
    "name": "生产模型渠道模板"
  }' \
  -o llmgateway-desired-config.json
```

new-api 只有普通页码分页，没有 cursor。导出会完整读取所有页、按渠道 ID 去重，并连续重扫；读取完明文密钥后还会重新校验渠道和全局配置。只有前后快照完全一致才返回文件，最多整体重试三次。若配置持续变化，导出会失败，不会返回跨时刻拼接的半份配置。

## 导入恢复

管理台点击“从备份恢复”并选择 JSON 文件。也可以调用：

```bash
curl -fsS https://CONTROL_HOST/api/desired-config/import \
  -H "Authorization: Bearer $LLMGATEWAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @llmgateway-desired-config.json
```

导入会先完整校验文件，再通过现有渠道模板引擎保存并生成不可变 revision。每份文件只允许一个黄金渠道包；任何渠道缺少明文密钥、渠道或配置键重复、状态/多 Key 模式非法、格式版本不支持时，都会在写入前拒绝。上传大小上限为 64 MiB。

导入只恢复 LLMGateway 的期望配置，不会在上传文件的同一次请求中自动覆盖远端 Set。恢复后应先“检查差异”，确认目标 Set，再执行批量发布；这保留了现有的漂移保护、失败停止和回滚语义。

## 范围边界

当前单文件覆盖平台渠道，以及会影响模型路由、请求转换、重试和计费结果的 new-api 配置。导出会剔除 `byok_` 前缀的用户私有分组，不包含租户、订阅、用户 API key、BYOK provider、Set/Shard 基础设施定义，也不会搬运支付、SMTP、OAuth、品牌等站点配置。这些数据仍由 LLMGateway MySQL 和基础设施备份负责。

渠道测试时间、响应耗时、余额、已用额度、自动禁用原因和多 Key 当前轮询下标属于运行状态，不进入 DesiredConfig。自动禁用渠道也不会被固化为人工禁用；恢复后由目标 Set 根据运行情况重新判断。
