# `.secret` 共享说明

本目录用于存放仓库外的真实敏感配置。

原则：

- 真实值只放在 `.secret/`，不放回 Git 跟踪文件
- 本目录下除本 README 外，其余文件都不提交
- 分享给同事时按最小范围分发，不要把整个目录无差别扩散

## 当前目录结构

```text
.secret/
  README.md
  cls-8gnhos9p-config
  ctl/
    local.env
    test.env
  sandbox/
    local.env
    test.env
```

说明：

- `.secret/ctl/local.env`
  - `ctl` 本地开发使用
- `.secret/ctl/test.env`
  - `ctl` 测试环境渲染与发布使用
- `.secret/sandbox/local.env`
  - `sandbox` 本地 compose 与 e2e 使用
- `.secret/sandbox/test.env`
  - `sandbox` 测试环境部署使用
- `.secret/cls-8gnhos9p-config`
  - 测试集群 kubeconfig

## 应该分享哪些文件

按需求最小化分享：

- 只做 `ctl` 本地开发：
  - `.secret/ctl/local.env`
  - 如需联调测试环境 `sandbox`，再加 `.secret/cls-8gnhos9p-config`
- 需要发布 `ctl` 测试环境：
  - `.secret/ctl/test.env`
  - `.secret/cls-8gnhos9p-config`
- 只做 `sandbox` 本地开发：
  - `.secret/sandbox/local.env`
- 需要发布 `sandbox` 测试环境：
  - `.secret/sandbox/test.env`
  - `.secret/cls-8gnhos9p-config`

不建议把整个 `.secret/` 目录原样发给所有人。

## 拿到文件后如何验证

### `ctl`

本地：

```bash
cd /root/code/mono/ctl
./conf/local/dev.sh status
./conf/local/services.sh status
```

渲染检查：

```bash
cd /root/code/mono
bash ctl/scripts/render-secrets.sh --env local
bash ctl/scripts/render-secrets.sh --env test
```

测试环境：

```bash
cd /root/code/mono/ctl
./scripts/deploy-test.sh status
```

### `sandbox`

本地：

```bash
cd /root/code/mono/sandbox
./scripts/dev-compose.sh config
./scripts/e2e/run.sh
```

测试环境：

```bash
cd /root/code/mono/sandbox
./scripts/deploy-k8s.sh status
```

### 通用检查

```bash
cd /root/code/mono
pre-commit run scan-secrets --all-files
```

## 文件格式约定

- `ctl/*.env` 与 `sandbox/*.env` 会被 shell 脚本 `source`
- 包含特殊字符的值，尤其是 DSN，建议使用双引号包住
- `sandbox/scripts/deploy-k8s.sh` 会先 `source` 再规范化写入 K8s Secret，允许 `test.env` 中的值带 shell 引号

## 更新与轮换

- 真实值轮换时，只更新对应 `.secret/...env`
- 更新后重新执行对应脚本：
  - `ctl`: `render-secrets.sh` / `deploy-test.sh`
  - `sandbox`: `dev-compose.sh` / `deploy-k8s.sh`
- 不要把轮换后的值写回仓库文档、README、脚本示例

## 禁止事项

- 不要提交 `.secret/ctl/*.env`、`.secret/sandbox/*.env`、kubeconfig
- 不要在群聊里直接粘贴密钥正文
- 不要把测试环境和本地环境凭据混发给不需要的人
- 不要把 `.secret` 中的真实值复制回 `README.md`、`docker-compose.yml`、`server_conf*.toml`
