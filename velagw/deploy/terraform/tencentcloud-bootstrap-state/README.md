# Terraform State Bootstrap

这个目录只负责创建生产 Terraform state 专用 COS bucket。它是一次性 bootstrap 层，允许用本地 state 跑一次；生产主目录 `../tencentcloud-prod` 不应该长期使用本地 state。

## 创建 state 桶

不要把云密钥写进文件，使用环境变量：

```bash
export TENCENTCLOUD_SECRET_ID="..."
export TENCENTCLOUD_SECRET_KEY="..."
```

执行：

```bash
cd deploy/terraform/tencentcloud-bootstrap-state
cp terraform.tfvars.example terraform.tfvars
tofu init
tofu plan -out bootstrap-state.tfplan
tofu apply bootstrap-state.tfplan
```

输出里的 `prod_backend_hcl` 会给出北京现有生产 state 所需的 backend 配置。这个 COS 桶可以保存多个地域的独立 state；backend 的 `region` 始终是桶所在地域，不是业务集群地域。

## 切换生产目录到 COS backend

在 `deploy/terraform/tencentcloud-prod` 下按目标地域复制 backend 示例。北京现网必须继续使用既有 prefix：

```hcl
region = "ap-beijing"
bucket = "llmgateway-prod-tfstate-<appid>"
prefix = "llmgateway/prod"
```

新增地域使用同一个桶时必须换独立 prefix，例如上海使用 `llmgateway/prod/shanghai`。不要修改北京 prefix 来追求命名一致；那会切到空 state。仓库中的 `backend/*.hcl.example` 已固化这个边界。

然后初始化生产目录：

```bash
cd deploy/terraform/tencentcloud-prod
tofu init -backend-config=backend.hcl
```

## 锁与权限

COS backend 支持 state locking。生产执行 Terraform 的 CAM 身份至少需要：

- 对 state bucket/prefix 的对象读写删权限。
- 对 lock 对象或 lock tag 的读写删权限。
- 腾讯云 COS backend 会创建名为 `tencentcloud-terraform-lock` 的 tag，CAM 策略需要允许 `tag:CreateTag`、`tag:DeleteTag`、`tag:DescribeTags`。

建议只允许 CI 或少数运维身份写入 state bucket，排障只读身份不要拥有写权限。

最小补充策略示例：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "tag:CreateTag",
        "tag:DeleteTag",
        "tag:DescribeTags"
      ],
      "resource": ["*"]
    }
  ]
}
```

如果 plan 报 `failed to create tag: tencentcloud-terraform-lock`，说明当前执行身份缺少上述 tag 权限。不要在生产长期使用 `-lock=false` 绕过。
