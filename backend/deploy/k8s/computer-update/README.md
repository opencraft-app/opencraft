# Computer Update 部署基线

这个目录只声明独立的单 Writer workload、ClusterIP Service、RWO PVC、ServiceAccount 和默认拒绝网络边界。
它故意使用 `computer-update.invalid` 与 `192.0.2.0/32`，因此不会直接部署成一个可访问的生产服务。

上线 overlay 必须原子地完成以下替换：

1. 把 Host、Origin、`--trusted-proxy-cidr` 与 NetworkPolicy 的保留值替换成真实的共享 Ingress 配置；
2. 在同 namespace 创建 `chatserver-computer-update-secrets`，只含 COS SecretId/SecretKey、在线 Channel
   私钥与离线 Release 公钥，不含离线 Release 私钥；
3. 在 PVC 的 `releases/<release-id>/` 中预置由发布机生成且完整验签的 Release Set；
4. 共享 qcloud Ingress 的 TLS Secret 同时配置 `qcloud_cert_id` 和 `qcloud_ca_cert_id`，为 operations Host
   开启客户端证书校验；
5. 在 CLB 与 Service 之间部署已验证的身份头适配器：先删除外部传入的
   `X-Vela-Operator-Fingerprint`，再用已验证客户端证书的 SHA-256 指纹覆盖而不是透传该 Header；
6. 把 NetworkPolicy 收紧到这个适配器的真实来源 CIDR，并验证 Pod 不能从其他来源直接访问。

腾讯云 qcloud Ingress 可以用 CA 证书启用双向 TLS，但当前官方说明没有承诺把客户端证书指纹转发给
后端。没有第 5 步时只能发布匿名 `/computer-releases/**`，不得开放 `/ops/computer-updates/**`。
