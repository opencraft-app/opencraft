# 插件与产品装配

核心拥有稳定入口和扩展契约，产品选择并配置自己的实现。每个扩展点声明贡献者数量、选择规则和停用后的行为。单一能力出现多个声明时，装配层给出可诊断的决策。

**目标样例。** 资产页拥有入口，Git 扩展点只接受一个已验证的贡献者。冲突时把该能力标为不可用。

```ts
function selectAssetsGit(providers: readonly GitProvider[]) {
  if (providers.length > 1) {
    const providerIds = providers.map((provider) => provider.id);
    return { kind: "conflict", providerIds } as const;
  }
  const [provider] = providers;
  if (!provider) return { kind: "absent" } as const;
  return { kind: "ready", provider } as const;
}
```

如果产品需要覆盖，装配明确选择贡献者。注册和停用以本次激活的标识为准。加载介质由宿主选择，扩展消费同一份包与能力契约。

**如何验证。** 核心单独装配时入口可用，装入一个产品贡献后仍只有一个入口，装入两个竞争贡献时能定位冲突。重新激活后，旧注册的清理回调不撤销新贡献。

现有参考见 [单贡献注册表](../packages/extension-runtime/src/single-contribution-registry.ts) 和 [运行时插件 VFS](../packages/runtime-plugin-host/package-vfs.mjs)。
