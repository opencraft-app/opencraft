# 批量预检/重置网关额度

`reset_gateway_user_quota.py` 通过 CTL 的单用户接口运行**有限的一轮**。默认只做 dry-run；`--limit all` 表示本轮不限制用户数，并非永久循环清零。目标可来自每行一个 `usr_` ID 的文件，或 CTL 中 Running Bot 的去重 owner；后者**不是全部订阅用户**。

脚本用 kubeconfig 从 `ctl-runtime-secrets` 读取内部令牌，在本机自动管理 `kubectl port-forward svc/ctl-api`，结束时关闭转发。运行账号需有读取该 Secret 和创建 port-forward 的权限。不要使用 `kubectl proxy`：它不能可靠转发本接口所需的 CTL Bearer 鉴权。

先小范围预检：

```bash
python3 ctl/scripts/reset_gateway_user_quota.py \
  --kubeconfig /etc/lightclaw-ci/kubeconfig_shprod \
  --environment shprod \
  --users-file /secure/path/users.txt \
  --state-file /secure/path/quota-sh-campaign.jsonl \
  --limit 10
```

Running Bot owner 全量预检：将目标来源改为 `--all-running-bots --limit all`。不同环境必须使用不同 checkpoint。脚本对用户去重、逐用户预检，日志中不打印令牌；checkpoint 含用户 ID，强制为 `0600` 并以独占锁防止同文件并发运行。每个用户完成后立即写入，重跑同一批次会跳过已完成的该模式记录。正式执行不会因为此前的 dry-run 记录而跳过用户。

批量生产操作应先把 Running Bot owner 固定为 `--users-file` 名单；在线分页结果会变化，仅保存“下一个 UID”不足以保证重跑不漏人或不重置。JSONL checkpoint 按 UID、模式记录已完成结果；执行前还会再次预检目标。真实重置请求发出前先持久化 `inflight`，若响应不明，后续运行会停止并要求人工对账，不会自动重投。

当本轮要求跳过积分包时，加 `--skip-additive-credit --credit-skip-file /secure/path/additive-credit-skips.jsonl --llmgateway-kubeconfig /etc/lightclaw-ci/kubeconfig_johorbahru_llmgateway_prod`。脚本逐人读取 LLMGateway 当前活跃订阅，遇到 `credit-package:` 或 `free-credit:` 会跳过，并把 UID、类别单独写入 0600 JSONL 文件供后续补发；无法确认订阅状态则停止，不做重置。执行前会再次检查。跳过也计入本轮 `--limit`，因此 `--limit 100` 最多检查 100 人、最多写入 100 人。可在 checkpoint 末尾的 `done.next_user_id` 查看固定名单的下一位；下次仍使用同一名单和 checkpoint。

如批量范围中可能有套餐正在隔离或没有活跃 Pass，可加 `--skip-ineligible-pass --ineligible-pass-file /secure/path/ineligible-pass-skips.jsonl`。仅在重置**预检**返回 HTTP 403 且错误码为已知 Pass 状态守卫时才单独记档并继续；未知 403 和真实写入阶段的任何不明结果仍立即停机。此类 UID 是“未重置”，不能算清零成功，后续需要按套餐状态再对账。

后台运行可以用：

```bash
umask 077
nohup python3 -u ctl/scripts/reset_gateway_user_quota.py \
  --kubeconfig /etc/lightclaw-ci/kubeconfig_shprod \
  --environment shprod \
  --all-running-bots --limit all \
  --state-file /secure/path/quota-sh-campaign.jsonl \
  > /secure/path/quota-sh-campaign.log 2>&1 < /dev/null &
```

审阅 dry-run 结果与目标范围后，正式清零需明确加上 `--execute --confirm RESET-USER-QUOTAS`，建议使用同一批次 checkpoint；仍会逐用户重新预检。如果一次执行的回执或网络结果不明，脚本停止，不自动重投，需先人工对账。要进行新一轮活动，使用新的 checkpoint 文件；不要删除或覆盖旧记录。该脚本不修改套餐总额度、周期或历史用量日志。
