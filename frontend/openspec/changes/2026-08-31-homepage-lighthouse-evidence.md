# Homepage Lighthouse evidence

**Date:** 2026-08-31
**Mode:** Lighthouse mobile simulated，冷缓存，每个站点和版本各 5 次。
**Baseline:** `6bdbd9d1530ba14effed60fd2ad5174e43952e09`。
**Raw reports:** global 位于 `/tmp/lightvela-homepage-lh.0X1diN`，CN 位于 `/tmp/lightvela-homepage-lh-cn.agjwoZ`。原始 JSON 不纳入仓库；下面保留全部 20 次关键指标和每份报告的 SHA-256，便于在当前工作机核验及与复测结果对照。

## Per-run results

| Site | Variant | Run | Perf | FCP ms | LCP ms | TBT ms | CLS | SHA-256 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| global | baseline | 1 | 63 | 4656.121 | 19209.182 | 35.0 | 0.000160 | `0a697a8aa33003a2d96e3e5f8641e2695407f1b8ced2022d03fdf9633724b613` |
| global | baseline | 2 | 61 | 4654.864 | 19207.296 | 41.0 | 0.000160 | `eeb135090162dd4819183958a4eebb956d19d1a2dea24350b487e960e088bb4a` |
| global | baseline | 3 | 63 | 4654.411 | 19206.617 | 27.5 | 0.000160 | `aac5707fe873b485db7f1572941edc478e101a605acf4d5917c478e219c0baca` |
| global | baseline | 4 | 63 | 4654.279 | 17707.132 | 46.0 | 0.000160 | `2b3e1d54362c092ab7ba8f94cdaa5ded58c537c9e9b80f35b6a0d3bc11856880` |
| global | baseline | 5 | 63 | 4654.851 | 19207.277 | 37.0 | 0.000160 | `16792c231ab5ab3ad0edf2aeb52e37b788f196763aad4f296cb3362c9f5ed385` |
| global | after | 1 | 62 | 4655.807 | 18159.677 | 44.5 | 0.000160 | `9d414563ccd9c8d34b4f3d055ae95c93f284ae1d6883bb75f467a8037a883587` |
| global | after | 2 | 63 | 4656.094 | 18160.157 | 47.5 | 0.000160 | `58c6ca3b25c8cde870193ecc6b9507c40081cbc1e05b670507b318b00e3ce9ff` |
| global | after | 3 | 63 | 4656.193 | 18160.322 | 37.5 | 0.000160 | `124e6c53d5c1f5b398fa1f52180745a7dbd5e419f0cba0d5afc927e5f2b0f0d8` |
| global | after | 4 | 63 | 4655.915 | 18159.858 | 39.0 | 0.000160 | `a61d57d3a743baa3fe3eb74ebe2193cc5a1c99874f9fc18b8a37a4ac643cd49e` |
| global | after | 5 | 63 | 4655.614 | 18159.356 | 31.0 | 0.000160 | `6a632da766c90263840c7eb980a0afc7e0e112dc61880341c2fa3beebc15aef1` |
| CN | baseline | 1 | 63 | 4654.143 | 18156.905 | 42.5 | 0.000084 | `1650c86a019796cab7f5bf3780c54ec5c5c996db0a19f64da8de18eb82f644ca` |
| CN | baseline | 2 | 63 | 4655.567 | 19208.350 | 37.0 | 0.000084 | `112a28c990d8c35d4bb4bb54cfb602e9d5b39f02b5b7366f95786b0313dcdee4` |
| CN | baseline | 3 | 63 | 4654.765 | 17707.942 | 45.0 | 0.000084 | `daf3e6394ed103fad2e7cf4d8f56dab933a9ff2b6ff450fee06bfe33d36a0cc8` |
| CN | baseline | 4 | 63 | 4656.756 | 19210.134 | 49.0 | 0.000084 | `2a08ac083acc08ce8d9894e4df00414b767b88d85327767f3e96dad1b3ab2cf9` |
| CN | baseline | 5 | 63 | 4654.620 | 19206.929 | 36.0 | 0.000084 | `23c5f081576446d0444e136992cd648819107ed392a2e0e3b5116c587993e57d` |
| CN | after | 1 | 63 | 4655.868 | 16283.802 | 31.5 | 0.000084 | `8cb304aafefbaa0811e08ba0e01dbfea458f7c9b79dc971f3fa6e9b22125338a` |
| CN | after | 2 | 63 | 4655.535 | 18158.303 | 32.5 | 0.000084 | `8b2f6c712a7415370eae7bd4c7522f5509995793f427aa12714d4f0667ab136c` |
| CN | after | 3 | 63 | 4654.608 | 17931.912 | 20.5 | 0.000084 | `854f861983dfb6989b11c6c87de7f59836e30c8b01808736ee6073b89ec0605f` |
| CN | after | 4 | 63 | 4655.471 | 18158.206 | 48.0 | 0.000084 | `f1dd9ad13ccceef893ffc1da083cfe008cd5cbee9d2bfb54f9b957db624a292c` |
| CN | after | 5 | 63 | 4655.021 | 18157.531 | 33.5 | 0.000084 | `fd3ff0eeb26fe355bb1867b096d055c28f6c8ba8afba9634e53298f870e3474f` |

## Medians

| Site | Variant | Perf | FCP ms | LCP ms | TBT ms | CLS |
|---|---|---:|---:|---:|---:|---:|
| global | baseline | 63 | 4654.851 | 19207.277 | 37.0 | 0.000160 |
| global | after | 63 | 4655.915 | 18159.858 | 39.0 | 0.000160 |
| CN | baseline | 63 | 4654.765 | 19206.929 | 42.5 | 0.000084 |
| CN | after | 63 | 4655.471 | 18157.531 | 32.5 | 0.000084 |

## Interpretation boundary

这是固定本机环境下的相对信号，不等同于线上 RUM。两站 LCP 中位数约改善 1.05 秒，但 performance 分数与 FCP 基本不变；global TBT 小幅变差、CN TBT 小幅改善，均可能属于运行波动。LCP 元素仍是 Hero 装饰图，因此本批不把结果描述为首屏瓶颈已解决，也不据此调整 Hero `fetchPriority`。
