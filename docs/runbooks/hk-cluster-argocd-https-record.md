# 香港集群 Argo CD 公网 HTTPS 接入操作记录

本文记录 `2026-04-18` 在香港 TKE 集群 `cls-mp5b5r0y` 上，为 `argocd.lightclaw.tech` 打通公网访问和 HTTPS 的完整过程。

## 1. 目标

- 为香港集群 `cls-mp5b5r0y` 开启公网 kube-apiserver 访问能力
- 在该集群内安装 Argo CD
- 为 `argocd.lightclaw.tech` 配置公网 HTTP/HTTPS 入口

说明：

- 本次操作是**直接走腾讯云控制面 API**完成的
- 当前仓库里**没有**香港环境对应的 `infra_pulumi` stack
- 因此这次变更**未纳入 IaC source of truth**

## 2. 关键资源

- 集群 ID：`cls-mp5b5r0y`
- 集群名称：`ArgoCD`
- 地域：`ap-hongkong`
- VPC：`vpc-a20j6qfy`
- 子网：`subnet-f0fy55i9`
- 子网路由表：`rtb-jat7cb4l`
- NAT 网关：`nat-is410myr`
- NAT 公网 IP：`119.28.6.114`

集群公网 API：

- 初始 TKE 外网入口 CLB：`lb-jj7e950m`
- 对应域名：`lb-jj7e950m-oh6l394mb75gp1jw.clb.hk-tencentclb.com`

Argo CD 公网入口：

- Ingress 名：`argocd-public`
- TkeServiceConfig：`argocd-public-config`
- Argo CD 入口 CLB：`lb-9whcawlg`
- 对应域名：`lb-9whcawlg-y6s403bajhidn2ev.clb.hk-tencentclb.com`

证书：

- 域名：`argocd.lightclaw.tech`
- 证书 ID：`WwibhrGX`
- 类型：`TrustAsia C1 DV Free`

## 3. 问题根因

最初 `helm install argo ...` 失败，不是 chart 或频率限制问题，而是节点所在子网**无法稳定出公网**。

关键症状：

- Argo CD 初始化 Job 拉镜像失败
- Pod 事件里报：
  - `failed to pull image "quay.io/argoproj/argocd:v3.3.7"`
  - `dial tcp ...:443: i/o timeout`

排查结果：

- `subnet-f0fy55i9` 绑定的路由表 `rtb-jat7cb4l` 初始是空的
- 没有 `0.0.0.0/0` 默认路由
- 因此运行在 `eklet-subnet-f0fy55i9-*` 上的 Pod 不能正常出公网

## 4. 处理步骤

### 4.1 开启集群公网 API 入口

先为集群创建外网 endpoint，并让公网访问通过腾讯云 CLB 暴露。

关键结果：

- `DescribeClusterEndpoints` 返回：
  - `ClusterExternalEndpoint: lb-a6zz65ou-6ufma7ykrp3gwv89.clb.hk-tencentclb.com:443`

说明：

- 这一阶段只说明集群已有公网入口对象
- 不代表 kube-apiserver 一定已经稳定可连

### 4.2 修复香港子网公网 egress

在香港新买 NATGW 后，给 `rtb-jat7cb4l` 补默认路由：

```bash
tccli vpc CreateRoutes \
  --region ap-hongkong \
  --cli-unfold-argument \
  --RouteTableId rtb-jat7cb4l \
  --Routes.0.DestinationCidrBlock 0.0.0.0/0 \
  --Routes.0.GatewayType NAT \
  --Routes.0.GatewayId nat-is410myr \
  --Routes.0.RouteDescription "default egress via natgw"
```

确认结果：

- `DescribeRouteTables` 中出现：
  - `DestinationCidrBlock: 0.0.0.0/0`
  - `GatewayType: NAT`
  - `GatewayId: nat-is410myr`

补完后，原本 `ErrImagePull` 的 Argo CD Job 重新拉镜像成功。

### 4.3 安装 Argo CD

先安装 Helm：

```bash
brew install helm
```

再添加 chart 仓库：

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
```

实际安装命令：

```bash
helm upgrade --install argo argo/argo-cd \
  --kubeconfig ./hk-cls-mp5b5r0y-extranet.kubeconfig \
  -n argocd \
  --create-namespace
```

最终结果：

- Helm release：`argo`
- namespace：`argocd`
- 状态：`deployed`

### 4.4 配置 Argo CD HTTP 入口

为 `argocd.lightclaw.tech` 创建 qcloud Ingress：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-public
  namespace: argocd
  annotations:
    kubernetes.io/ingress.class: qcloud
    ingress.cloud.tencent.com/modification-protection: "false"
    ingress.cloud.tencent.com/direct-access: "true"
    ingress.cloud.tencent.com/tke-service-config: argocd-public-config
spec:
  ingressClassName: qcloud
  rules:
    - host: argocd.lightclaw.tech
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: argo-argocd-server
                port:
                  number: 80
```

关键结果：

- Argo CD Ingress CLB：`lb-9whcawlg`
- 域名：`lb-9whcawlg-y6s403bajhidn2ev.clb.hk-tencentclb.com`

DNS：

```bash
tccli dnspod CreateRecord \
  --Domain lightclaw.tech \
  --SubDomain argocd \
  --RecordType CNAME \
  --RecordLine 默认 \
  --Value lb-9whcawlg-y6s403bajhidn2ev.clb.hk-tencentclb.com
```

### 4.5 申请并签发免费 HTTPS 证书

申请：

```bash
tccli ssl ApplyCertificate \
  --DvAuthMethod DNS_AUTO \
  --DomainName argocd.lightclaw.tech
```

结果：

- 证书 ID：`WwibhrGX`

实际情况：

- `DNS_AUTO` 申请成功了，但腾讯云没有自动完成 DNS 验证落地
- 需要手工确认 TXT 记录

验证记录：

- `_dnsauth.argocd.lightclaw.tech`
- 值：
  `2026041619384818ie3norw22t3j9borzgdkqpy7hwv94oqb7l0bqpb0rxitc2v9`

该 TXT 最终在 DNSPod 中确认已存在，随后证书状态变为：

- `StatusName: 已颁发`

### 4.6 配置 HTTPS 入口

关键点：

- qcloud Ingress **不接受**普通 `kubernetes.io/tls` Secret 作为证书来源
- 必须使用：
  - `type: Opaque`
  - `stringData.qcloud_cert_id`
  - `metadata.annotations.qcloud_cert_id`

正确的 Secret 形态：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-tls
  namespace: argocd
  annotations:
    qcloud_cert_id: WwibhrGX
type: Opaque
stringData:
  qcloud_cert_id: WwibhrGX
```

然后给 Ingress 增加 TLS：

```yaml
tls:
  - hosts:
      - argocd.lightclaw.tech
    secretName: argocd-tls
```

同时在 `TkeServiceConfig` 中增加 `HTTPS 443` listener。

最终在 CLB `lb-9whcawlg` 上确认到：

- `Protocol: HTTPS`
- `Port: 443`
- `Domain: argocd.lightclaw.tech`
- `Certificate.CertId: WwibhrGX`

## 5. 最终结果

Argo CD 已安装完成并可通过公网访问：

- HTTP：`http://argocd.lightclaw.tech`
- HTTPS：`https://argocd.lightclaw.tech`

Argo CD 基本状态：

```bash
kubectl --kubeconfig ./hk-cls-mp5b5r0y-extranet.kubeconfig -n argocd get pods
```

关键 Pod 已全部进入 `Running`。

初始登录信息：

- 用户名：`admin`
- 初始密码：运行时通过 `argocd-initial-admin-secret` 获取

建议后续立即执行：

1. 修改 `admin` 初始密码
2. 评估是否开启 SSO
3. 评估是否对公网入口加白名单

## 6. 经验总结

### 6.1 不是“镜像仓库限流”，而是 NAT/路由问题

这次 `quay.io` 拉镜像失败的真实原因是：

- 子网 `subnet-f0fy55i9` 没有默认路由到 NATGW

不是：

- Helm 问题
- Argo CD chart 问题
- Quay 限流

### 6.2 qcloud Ingress 的 TLS secret 要按腾讯云约定来

不要给 qcloud Ingress 直接喂：

- `type: kubernetes.io/tls`
- `tls.crt / tls.key`

在当前这套环境里，应优先用：

- `type: Opaque`
- `qcloud_cert_id`

### 6.3 这次变更还没有纳入 IaC

当前仓库里没有香港环境对应的 `infra_pulumi` stack / inventory。  
因此这次 NAT、公网 endpoint、证书、Ingress 都是**手工控制面变更**。

如果后续要长期维护香港环境，建议补齐：

- `infra_pulumi/envs/tencentcloud/<hongkong-env>/inventory.yaml`
- `Pulumi.<hongkong-env>.yaml`

并把：

- NAT
- 路由表
- TKE cluster public endpoint
- 域名/证书依赖关系

都收回 IaC。
