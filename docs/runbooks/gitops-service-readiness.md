# GitOps Service Readiness

服务只有满足下面条件，才算 Argo-ready。

## Required

- 已有 `k8s/base + k8s/overlays/<env>`
- image tag contract 明确且 Git 中可见
- required secrets 来自 `*.sops.yaml`
- 不依赖本地 `.secret/*`
- 不依赖本地-only `generated/*`
- Argo sync 可在无本地 operator context 下重建部署状态
- rollback 可以通过 `git revert + Argo sync`

## Wave Ordering Rubric

优先级从高到低：

1. 已有 `k8s/base + overlays`
2. 不依赖本地 `.secret/*`
3. 不依赖 `generated/*`
4. image contract 稳定
5. secret 复杂度低
6. blast radius 低

## Migration Checklist

- [ ] deploy artifact 已从源码树中收敛为 Argo 可消费入口
- [ ] secret 已纳入 `SSM -> sops`
- [ ] image pin 已进入 Git
- [ ] Argo App 已定义
- [ ] 北京测试同步成功
- [ ] 文档里标注 Argo primary / script fallback
- [ ] 至少一次 rollback 演练完成
