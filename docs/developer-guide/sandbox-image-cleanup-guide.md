# Sandbox Image Cleanup Guide

本文档约束 `sandbox` 镜像清理时的安全边界和执行步骤，避免误删当前 pool 在用镜像、待 rollout 镜像，或误删非目标命名空间的私有镜像。

## 1. 清理范围

默认只清理同时满足下面条件的镜像：

- 地域限定在目标地域，例如 `ap-seoul`、`ap-beijing`
- `ImageType=PRIVATE_IMAGE`
- `ImageName` 以 `lightclaw` 开头
- 不在当前保留集里

默认不要清理：

- 当前 pool 正在使用的镜像
- 已构建但尚未 rollout、准备下一步上线的镜像
- 非 `lightclaw*` 命名的测试镜像，除非用户明确点名

## 2. 保留集定义

执行删除前，先明确保留集。当前推荐的最小保留规则是：

1. 当前测试环境 pool 实际绑定的北京镜像
2. 当前最新待 rollout 的北京镜像
3. 当前稳定 `base` 镜像
4. 当前最新首尔 app 镜像
5. 如有需要，再额外保留一个上一个稳定 app 镜像用于回退

以 `2026-03-27` 当前环境为例，保留集是：

- `ap-seoul`
  - `img-id352nof`
  - `img-l46uq8u5`
  - `img-p75ydx8d`
- `ap-beijing`
  - `img-fn65zi17`
  - `img-298f5mcp`

## 3. 删除前核对

### 3.1 查当前 pool 在用镜像

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-pool-cfg-cleanup --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h 10.15.224.4 -P 3306 -u root -p'***' cvm -e \
  "SELECT DISTINCT base_image FROM pools ORDER BY base_image;"
```

### 3.2 列出目标地域所有 `lightclaw*` 私有镜像

```bash
python3 - <<'PY'
import json, subprocess
region='ap-beijing'
out=subprocess.check_output([
    'tccli','cvm','DescribeImages','--region',region,
    '--Filters','[{"Name":"image-type","Values":["PRIVATE_IMAGE"]}]'
], text=True)
data=json.loads(out)
for img in sorted(data.get('ImageSet',[]), key=lambda x: x.get('CreatedTime','')):
    name=img.get('ImageName','')
    if name.startswith('lightclaw'):
        print(img.get('ImageId',''), img.get('CreatedTime',''), name)
PY
```

### 3.3 生成删除集

规则：

- 删除集 = `lightclaw*` 私有镜像 - 保留集
- 删除前必须人工扫一遍名称、时间、地域，确认没有把“当前待 rollout 镜像”算进去

## 4. 执行删除

示例：删除北京地域的历史 `lightclaw*` 镜像

```bash
tccli cvm DeleteImages --region ap-beijing --ImageIds '[
  "img-xxxx",
  "img-yyyy"
]'
```

说明：

- `DeleteImages` 可以一次传多个 `ImageId`
- 删除请求返回 `RequestId` 只表示请求已接受，不代表查询结果立即收敛
- 删除后建议等待数秒再 `DescribeImages` 复查

## 5. 删除后复查

```bash
python3 - <<'PY'
import json, subprocess
for region in ['ap-seoul','ap-beijing']:
    out=subprocess.check_output([
        'tccli','cvm','DescribeImages','--region',region,
        '--Filters','[{"Name":"image-type","Values":["PRIVATE_IMAGE"]}]'
    ], text=True)
    data=json.loads(out)
    print('===', region, '===')
    for img in sorted(data.get('ImageSet',[]), key=lambda x: x.get('CreatedTime','')):
        name=img.get('ImageName','')
        if name.startswith('lightclaw'):
            print(img.get('ImageId',''), img.get('CreatedTime',''), name)
PY
```

复查目标：

- 只剩保留集中的镜像
- 当前 pool 在用镜像仍存在
- 当前待 rollout 镜像仍存在

## 6. 清理后的文档动作

完成清理后，至少同步两处：

- 更新 [sandbox-image-version-inventory.md](sandbox-image-version-inventory.md)
- 如清理策略或边界发生变化，更新 [sandbox-agent-guide.md](../agent-guides/sandbox-agent-guide.md)

## 7. 本次实操结论

`2026-03-27` 已按本指引完成一次实际清理：

- `ap-seoul` 只保留：
  - `img-id352nof`
  - `img-l46uq8u5`
  - `img-p75ydx8d`
- `ap-beijing` 只保留：
  - `img-fn65zi17`
  - `img-298f5mcp`
- `ap-shanghai` 没有 `lightclaw*` 私有镜像，无需处理

这次没有清理：

- 非 `lightclaw*` 命名的测试镜像
- 当前 pool 正在使用的镜像
- 最新待 rollout 的镜像
