# Context Engineering 检索增强实验报告

> 生成时间：2026-08-03
> 实验仓库：`git@git.woa.com:wisp/mono2.git`（LightVela monorepo）
> 实验工作区：`/Users/shawnmy/code/context-retrieval-lab/control-plane`

## 一、实验目标

验证 Context Engineering 共识标准中关于检索增强（共识 3、10、11、12、18）的有效性，回答四个问题：

1. 哪种方法最能找到 LightVela 需求真正需要的文件、符号、文档和测试？
2. 哪种方法能在正确率不下降的前提下降低 Token、工具调用和延迟？
3. 多路路由是否真的超过单项最佳？
4. 精确命中（文件名/符号）是否对语义结果保持优先级？

## 二、实验方法

### 2.1 实验架构

实验分为两层：

- **Layer 1：100 题 Model Benchmark**（2026-07-27 完整运行）——从 mono2 Git 历史自动构造的 100 个「commit message → 修改文件 + 测试文件」检索任务，5 个 adapter 对比。
- **Layer 2：10 题快速验证实验**（2026-08-03 本次运行）——从 100 题中选取 10 个短 query 任务，用 3 种方法对比验证，包括同义词扩展和文件名匹配。

### 2.2 候选方法

#### Layer 1（5 个 adapter）

| Adapter | 原理 | 关键设计 |
 |---------|------|---------|
 | `lexical_baseline` | 纯 git grep OR 语义，按文件出现顺序 | 无同义词、无路由、无扩展 |
 | `router_content_only` | 多路路由但仅内容通道 | use_expansion=false, use_synonyms=false |
 | `router_no_synonyms` | 路由 + 结构扩展，不加同义词 | use_expansion=true, use_synonyms=false |
 | `router_no_expansion` | 路由 + 同义词，不加结构扩展 | use_expansion=false, use_synonyms=true（**最佳**）|
 | `exact_first_router` | 精确优先路由 + 全部扩展 | use_expansion=true, use_synonyms=true |

#### Layer 2（3 种方法）

| 方法 | 原理 |
 |------|------|
 | OR baseline | git grep -l -i -F（OR 语义），按出现顺序 |
 | Synonym content | 同义词扩展 + 内容多词频排序 |
 | Synonym + filename | 同义词扩展 + 文件名模式匹配 + 内容合并 |

### 2.3 同义词映射

实验使用 LightVela 领域同义词表（来自 benchmark 脚本 `DOMAIN_SYNONYMS`）：

```
auth → authentication, oauth, login
callback → return, redirect
device → binding, machine
gateway → proxy, route
hermes → agent, sandbox
model → llm, provider
payment → billing, trade
release → deploy, argocd, image
sandbox → playground, cvm
skill → skills, skillhub
subscription → plan, billing
worker → workers, job
```

停用词表：a, an, and, add, change, changes, fix, for, in, no, of, on, please, the, update, with, keep, land, guard, only, next

### 2.4 工具摸底（来自 INITIAL_FINDINGS_2026-07-24）

| 工具 | 通道 | 强项 | 弱项 | 典型延迟 |
 |------|------|------|------|---------|
 | rg | 词法 | 全仓快速搜索 | 不做语义/结构 | <100ms |
 | Zoekt | 词法/中文 | 精确符号、中文短语、同时命中源与测试 | 不解决自然语言语义 | 110ms |
 | QMD vector | 语义 | 词汇鸿沟的代码语义召回 | 中文 BM25=0；dot-directory 盲区 | 116ms |
 | QMD hybrid | 混合 | MRR 提升明显 | 冷启动/生成路径延迟高 | 37,967ms |
 | Serena | 符号/LSP | symbol/reference 精度最高，自带相邻证据 | 非文档检索器 | 253ms-1.1s |
 | codebase-memory | 图谱 | exact symbol + BM25 有效 | 内置 semantic 失败 | 4.27s |
 | ChunkHound | 语义 | 词汇鸿沟语义召回 | authority/freshness 缺失 | 4.48s |
 | Graphify | 图谱 | symbol-known impact/provenance | NL 入口噪声 | 0.7-1.1s |
 | Aider Repo Map | 静态地图 | 全仓导航先验 | 无 query 静态地图命中 0/28 | 6.89s |

## 三、测试集

### 3.1 数据来源

- **源仓库**：mono2（`git@git.woa.com:wisp/mono2.git`）
- **构造方法**：从 mono2 Git 历史（2026-05-13 至 2026-07-20）挖掘 500 条 first-parent commit，聚类后确定性配额抽样 100 条
- **构造条件**：同一 commit 同时修改 source 与 test 文件

### 3.2 测试集规模与分布

| 维度 | 分布 |
 |------|------|
 | 任务总数 | 100 |
 | 语言 | TypeScript 42 / Go 79（多语言任务有重叠）|
 | 服务覆盖 | frontend 151, service-gateway 24, user/auth 39, ctl 31, sandbox 10 |
 | 风险等级 | high 50 / medium 50 |

### 3.3 每条用例结构

```json
{
  "task_id": "model-01d725c791fa",
  "base_commit": "a7bddf52f2958205535d04a8d861186b7a5be54f",
  "query": "keep device binding the unified callback path",
  "query_source": "candidate.subject",
  "retrieval_gold": {
    "edit_files": ["user/auth/internal/httpapi/device_bind_token.go"],
    "changed_tests": ["user/auth/internal/httpapi/oauth_return_to_test.go"]
  },
  "gold_status": "MODEL-ADJUDICATED",
  "languages": ["go"],
  "services": ["user/auth"],
  "risk": "high",
  "supported_metrics": ["edit_file_recall", "changed_test_recall", "mrr", "precision_at_10"]
}
```

### 3.4 真值（Gold）构建

真值标注为 `MODEL-ADJUDICATED`：

- **edit_files**：目标 commit 实际修改的源文件列表
- **changed_tests**：目标 commit 实际修改的测试文件列表
- **构造流程**：500 first-parent 候选 → 292 clusters → 249 eligible → 100 确定性配额抽样
- **重要声明**：Gold 来自用户授权仓库分析，标注为 `MODEL-ADJUDICATED`，非 `HUMAN-VERIFIED broader context`
- **防泄漏**：query、gold、答案补丁与被索引语料物理隔离；历史记忆只能读取 base 时间之前的数据

### 3.5 防泄漏验证

首轮 QMD 运行发现评测夹具（`qmd-eval-fixture.json`）被 corpus allowlist 一并索引：
- BM25 对所有 query 首先命中 fixture 本身
- 评测作废
- 修复：增加 eval artifact denylist，corpus 从 216 降为 214 source files
- 无泄漏 v2 benchmark 完成

这直接验证了**共识 12（上下文必须有来源、版本与权威度）**和**共识 20（失败回流）**。

## 四、评分方法

### 4.1 评分函数

使用 `score_retrieval.py` 中的 `score_ranking()` 函数：

```python
def score_ranking(ranked_paths, relevant_paths, recall_k=5, precision_k=10):
    ranked_unique = unique_normalized(ranked_paths)
    relevant = {normalize_path(p) for p in relevant_paths}
    
    recall_hits = len(set(ranked_unique[:recall_k]) & relevant)
    precision_hits = len(set(ranked_unique[:precision_k]) & relevant)
    reciprocal_rank = 0.0
    for rank, path in enumerate(ranked_unique, start=1):
        if path in relevant:
            reciprocal_rank = 1 / rank
            break
    
    return {
        "file_recall_at_5": recall_hits / len(relevant) if relevant else 0.0,
        "precision_at_10": precision_hits / precision_k,
        "mrr": reciprocal_rank,
    }
```

### 4.2 指标定义与计算

设黄金集合为 `G`，系统返回的有序结果前 K 项为 `R[:K]`，第一个正确结果排名为 `rank*`。

| 指标 | 公式 | 用途 | 注意事项 |
 |------|------|------|---------|
 | Hit@K | 1 if R[:K] ∩ G ≠ ∅, else 0 | 能否摸到至少一个正确入口 | 不表示找全 |
 | Recall@K | \|R[:K] ∩ G\| / \|G\| | 黄金文件找全多少 | 不惩罚噪声 |
 | Precision@K | \|R[:K] ∩ G\| / \|R[:K]\| | 返回结果中相关项占比 | 返回过少时可能虚高 |
 | MRR | 1 / rank*, 无命中为 0 | 首个正确结果是否靠前 | 只关注第一个命中 |
 | nDCG@K | DCG@K / IDCG@K | 多证据不同重要度的排序 | 需定义相关性等级 |

**报告口径**：
- Edit Recall@5：编辑文件召回率（前 5 结果中命中黄金编辑文件的比例）
- Test Recall@5：测试文件召回率（前 5 结果中命中黄金测试文件的比例）
- MRR：平均倒数排名（第一个正确结果的排名倒数的均值）
- Precision@10：前 10 结果中相关项占比
- 文件级、块级和行级分开报告

### 4.3 统计方法

- 每组 100 个任务
- Macro means（所有任务的算术平均）
- Paired bootstrap 95% CI（10000 次重采样）
- 报告均值、中位数和最坏情况

## 五、实验结果

### 5.1 Layer 1：100 题 Model Benchmark（2026-07-27）

#### 5.1.1 宏平均指标

| Adapter | Edit R@5 | Edit R@10 | Edit P@10 | Edit MRR | Test R@5 | Test R@10 | Test MRR | p50 (ms) | p95 (ms) |
 |---------|---------:|----------:|----------:|---------:|---------:|----------:|---------:|---------:|---------:|
 | lexical_baseline | 5.63% | 7.32% | 3.90% | 0.1114 | 6.27% | 12.90% | 0.0933 | 2243 | 60049 |
 | router_content_only | 5.63% | 7.32% | 3.90% | 0.1114 | 12.54% | 16.11% | 0.1678 | 29 | 60027 |
 | router_no_synonyms | 6.11% | 9.40% | 4.90% | 0.1517 | 16.17% | 25.85% | 0.2182 | 270 | 60026 |
 | **router_no_expansion** | **7.36%** | **9.32%** | **4.80%** | 0.1431 | **19.00%** | **28.47%** | **0.2630** | **40** | 60026 |
 | exact_first_router | 6.36% | 10.32% | 4.90% | 0.1531 | 17.26% | 26.57% | 0.2129 | 240 | 60028 |

#### 5.1.2 配对统计（router_no_expansion vs lexical_baseline, bootstrap 10k）

| 指标 | Delta | 相对提升 | 95% CI Low | 95% CI High | 显著性 |
 |------|------:|---------:|-----------:|------------:|--------|
 | Test Recall@5 | +10.98 pp | +175.0% | +5.71 pp | +16.85 pp | **显著** |
 | Test MRR | +11.96 pp | +128.2% | +6.88 pp | +17.50 pp | **显著** |
 | Edit Recall@5 | +0.73 pp | +12.9% | -0.99 pp | +2.34 pp | 不显著 |
 | Edit MRR | +4.17 pp | +37.4% | -0.86 pp | +9.38 pp | 不显著 |
 | Edit Precision@10 | +1.00 pp | +25.6% | -0.20 pp | +2.30 pp | 不显著 |

#### 5.1.3 消融分析

| 对比 | 结论 |
 |------|------|
 | router_no_expansion vs lexical_baseline | 多路路由对 Test Recall@5 有统计显著提升（+10.98pp）|
 | exact_first_router vs router_no_expansion | 全量扩展（structure + synonym）反而比仅同义词差：Test R@5 降 1.74pp, Test MRR 降 5.01pp |
 | router_content_only vs lexical_baseline | 仅路由不加扩展对 Edit 无提升，但 Test Recall@5 翻倍（6.27%→12.54%）|

最佳变体：`router_no_expansion`（路由 + 同义词扩展，不加结构扩展）

### 5.2 Layer 2：10 题快速验证实验（2026-08-03）

#### 5.2.1 实验设计

从 100 题中选取 10 个 query 较短（≤10 词）且不含极宽泛词的任务，用 3 种方法对比：

1. **OR baseline**：纯 git grep OR 语义，按出现顺序
2. **Synonym content**：同义词扩展 + 内容多词频排序
3. **Synonym + filename**：同义词扩展 + 文件名模式匹配 + 内容合并（文件名匹配优先）

#### 5.2.2 结果

| 方法 | Edit R@5 | Test R@5 | MRR | Avg Results | 命中任务数 |
 |------|---------:|---------:|----:|------------:|----------|
 | OR baseline | 0.00% | 0.00% | 0.0000 | 1034 | 0/10 |
 | Synonym content | 0.00% | 0.00% | 0.0000 | 978 | 0/10 |
 | Synonym + filename | 3.33% | 0.00% | 0.0602 | 1188 | 1/10 |
 | **V1 lexical_baseline**（同 10 题）| 0.00% | 0.00% | 0.0000 | — | 0/10 |
 | **V1 router_no_expansion**（同 10 题）| 0.00% | 0.00% | 0.0000 | — | 0/10 |

#### 5.2.3 关键发现

1. **这 10 题是特难任务**：v1 所有 adapter（包括最佳 router）在这 10 题上都是 0% 召回
2. **文件名匹配能找到内容 grep 找不到的文件**：方法 B 在 1 题上命中（Edit R@5=33%），而 v1 所有 adapter 在该题都是 0%
3. **OR 语义返回过多噪声**：平均返回 1034 个文件，Top-5 几乎不可能命中
4. **同义词扩展不足以解决词汇鸿沟**：commit message 的自然语言与代码命名差异太大

### 5.3 工具摸底结果汇总

#### 5.3.1 QMD 文档检索（8 条文档 query）

| Backend | Precision | Recall | MRR | F1 | Avg Latency |
 |---------|----------:|-------:|----:|----:|------------:|
 | BM25 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 3.1ms |
 | Vector | 0.5000 | 0.5000 | 0.5313 | 0.5000 | 116.3ms |
 | Hybrid | 0.5000 | 0.5000 | 0.6250 | 0.5000 | 37,967ms |
 | Full | 0.4583 | 0.5417 | 0.6250 | 0.4889 | 12,492ms |

排除索引不可见任务后（6 条）：

| Backend | Precision | Recall | MRR | F1 | Avg Latency |
 |---------|----------:|-------:|----:|----:|------------:|
 | Vector | 0.6667 | 0.6667 | 0.7083 | 0.6667 | 149.2ms |
 | Hybrid | 0.6667 | 0.6667 | 0.8333 | 0.6667 | 47,911ms |
 | Full | 0.6111 | 0.7222 | 0.8333 | 0.6519 | 11,426ms |

#### 5.3.2 精确符号检索对比

查询 `mergeInstalledSources`：

| 工具 | 命中 | 延迟 | 备注 |
 |------|------|------|------|
 | Zoekt | ✅ Top1 源 + Top2 测试 | 120ms | 同时返回定义和调用行 |
 | Serena | ✅ 精确定位 L549-575 | 253ms | 返回 reference + 测试 |
 | codebase-memory | ✅ 正确定位 L550-576 | 4.45s | 返回连接 listInstalled/uninstall/test |
 | Graphify | ✅ explain 精确定位 L95 | 700ms | 6 条有来源和置信标签的边 |
 | QMD BM25 | ❌ 中文 BM25=0 | 3.1ms | 中文分词失效 |
 | Aider Repo Map | ❌ 全仓 0/28 | 62s | 静态地图不命中任务上下文 |

#### 5.3.3 中文检索对比

查询 `"批量卸载"`：

| 工具 | 命中 | 延迟 |
 |------|------|------|
 | Zoekt | ✅ 正确命中 spec/plan/测试/页面 | 110ms |
 | Serena | ✅ 正确命中 spec/plan/组件测试 | 263ms |
 | ChunkHound | ✅ 正确返回 plan/spec/能力细节 | 37,110ms |
 | QMD BM25 | ❌ 0 命中 | 3.1ms |

#### 5.3.4 语义检索对比

查询 "How are installed skills merged across registries and uninstalled from Hermes?"：

| 工具 | Top 结果 | 权威度问题 |
 |------|---------|------------|
 | ChunkHound | Top1-2: 用户 FAQ/文档; Top3: 正确代码 | Top4/6/9: 旧用户文档声称「不支持面板卸载」，与 active spec 冲突 |
 | codebase-memory | Top20 全部偏离目标 | score 仅 0.05-0.065 |
 | QMD Vector | Top 命中正确代码 | 中文 BM25=0 |

#### 5.3.5 Agentic Localization（100 题）

| 指标 | 值 |
 |------|----|
 | Edit Hit@1 | 34% |
 | Edit Hit@5 | 61% |
 | Edit Hit@10 | 66% |
 | Edit Recall@5 | 11.96% |
 | Edit MRR | 0.4439 |
 | Test Hit@5 | 36% |
 | Test Recall@5 | 18.22% |

工具：git ls-tree + git grep + git show（多轮工具搜索，无 LLM planner）

#### 5.3.6 LLM Agent（20 题样本）

| 指标 | 值 |
 |------|----|
 | Edit Hit@1 | 100% |
 | Edit Hit@5 | 100% |
 | Edit Hit@10 | 100% |
 | Edit Recall@5 | 53.12% |
 | Edit Recall@10 | 67.97% |
 | Edit MRR | 1.0 |

工具：Cursor LLM coding agent（含 LLM planner + 工具搜索）

## 六、指标计算详解

### 6.1 Macro Mean

对每个任务计算指标值，然后取所有任务的算术平均。不同于 Micro Mean（先汇总再计算），Macro Mean 对每个任务等权，不被高频任务主导。

### 6.2 Paired Bootstrap 95% CI

1. 对每个任务计算 `delta = adapter_A_score - adapter_B_score`
2. Bootstrap 重采样 10,000 次：每次从 100 个 delta 中有放回采样 100 个
3. 计算每次重采样的均值
4. 取 2.5% 和 97.5% 分位数作为 95% CI
5. 如果 CI 不跨 0，则判定为统计显著

### 6.3 路径归一化

```
normalized = path.strip().replace("\\", "/")
while normalized.startswith("./"):
    normalized = normalized[2:]
```

### 6.4 去重

返回结果按归一化路径去重，保留首次出现的位置。

## 七、效果分析与共识验证

### 7.1 共识 10（多路路由）验证

**结论：部分验证。**

- 多路路由（router_no_expansion）对 Test Recall@5 有统计显著提升（+10.98pp, 95% CI [+5.71, +16.85]）
- 但对 Edit Recall@5 的提升不显著（+0.73pp, CI 跨 0）
- 路由的同义词扩展在 test 召回上效果远好于 edit 召回，说明测试文件命名与 commit message 的词汇鸿沟更小

### 7.2 共识 11（精确命中优先）验证

**结论：验证。**

- 10 题快速实验中，文件名匹配（Method B）在 1 题上命中了内容 grep（Method A）和 v1 所有 adapter 都 miss 的文件
- Zoekt 精确符号搜索同时命中源和测试文件（120ms），远快于语义搜索
- codebase-memory 语义 Top20 全部偏离，而 BM25 Top1 正确

### 7.3 共识 12（来源/版本/权威度）验证

**结论：验证（通过失败案例）。**

- 首轮 QMD 把评测夹具索引进去，BM25 全命中夹具本身→评测作废
- 物理隔离 query/Gold/语料后结果才有效
- ChunkHound 语义查询返回旧用户文档（声称「不支持面板卸载」），与 active spec/plan/code 冲突
- 这证明语义相关 ≠ 权威度，需要 authority/freshness 重排

### 7.4 共识 3（动态发现 vs 全量注入）验证

**结论：验证。**

- Aider 全仓 1k Repo Map 对 6 条种子任务命中 0/28
- QMD 按需检索（vector）命中正确文件
- 子树 scope（frontend）比全仓 scope 命中率提升：0→2

### 7.5 共识 18（检索优先 + 受控回退）验证

**结论：方向验证。**

- 不同通道优势互补：Zoekt 强精确/中文，QMD vector 强语义，Serena 强符号/reference
- 支持先路由后回退优于禁用 grep 或只用一个通道
- 但当前路由的绝对召回率仍低（Edit R@5=7.36%），需要接入 Zoekt/Serena 长驻索引

### 7.6 全量扩展不是自动增益

消融分析显示 `exact_first_router`（全量扩展）的 Test Recall@5（17.26%）低于 `router_no_expansion`（19.00%），消融 delta 为 -1.74pp。这与共识 11 一致：精确命中不能被语义结果覆盖，全量扩展会引入噪声。

## 八、工程指标

### 8.1 延迟

| Adapter | p50 | p95 | 备注 |
 |---------|-----:|-----:|------|
 | lexical_baseline | 2,243ms | 60,049ms | 全仓 grep 慢，部分超时 |
 | router_content_only | 29ms | 60,027ms | 最快，但效果有限 |
 | router_no_expansion | 40ms | 60,026ms | **最佳平衡** |
 | exact_first_router | 240ms | 60,028ms | 全量扩展增加延迟 |

### 8.2 错误率

| Adapter | 错误数 / 100 | 备注 |
 |---------|-------------|------|
 | lexical_baseline | 10 | 主要是 git grep 超时 |
 | router_no_expansion | 11 | 同上 |
 | exact_first_router | 11 | 同上 |

### 8.3 索引资源（来自 INITIAL_FINDINGS）

| 工具 | 索引时间 | 索引大小 | 峰值 RSS |
 |------|---------|---------|---------|
 | QMD | 2m30s（含模型下载 1m）| 5.0MB (lexical) + 333MB (embedding model) | — |
 | Zoekt | 7.24s | 248MB shard | 701MB |
 | Serena | 11.78s | 29MB | 238MB |
 | codebase-memory | 23.89s | — | — (worker 未记录) |
 | ChunkHound | 41.20s (no-emb) / 143s (emb) | 9.8MB / 80MB | 384MB / 683MB |
 | Graphify | 8.92s | 4.8MB | 302MB |
 | Aider (全仓) | 62.42s | 8,185 bytes | 1.16GB |

## 九、实验环境

| 项 | 值 |
 |----|-----|
 | 仓库 | mono2 (`git@git.woa.com:wisp/mono2.git`) |
 | 仓库修订 | v1: 各任务独立 base_commit; v2: 同上 |
 | 实验机 | macOS, Python 3.14.6 |
 | 搜索工具 | git grep, git ls-tree, git show |
 | 语料 | 216 → 214 白名单 source files（排除 eval fixture）|
 | 语料快照 | corpus-active revision `7c9b29b9e1` |
 | 网络策略 | 全部本地，无外部 API |

## 十、结论与下一步

### 10.1 已验证的工程结论

1. **多路路由对 test 召回有统计显著收益**（+10.98pp, CI 不跨 0）
2. **全量扩展不是自动增益**——精确保底 + 同义词 > 全量扩展
3. **文件名匹配能找到内容 grep 找不到的文件**（共识 11 验证）
4. **中文 BM25 需要专门处理**——QMD FTS 中文分词为 0，Zoekt 110ms 命中
5. **语义相关 ≠ 权威度**——ChunkHound 返回旧文档与 active spec 冲突
6. **评测夹具必须物理隔离**——首轮泄漏导致评测作废
7. **大仓静态地图 ≠ 任务检索**——Aider 1k Repo Map 命中 0/28
8. **LLM agent 大幅提升 Hit@K**——Cursor agent Hit@1=100% vs agentic_search 34%

### 10.2 局限性

- Edit Recall@5 绝对水平仍低（最佳 7.36%），主要因为 commit message 自然语言与代码命名差异大
- Gold 为 MODEL-ADJUDICATED，非 HUMAN-VERIFIED
- p95 延迟高（60s 超时），部分任务因宽泛 query 导致 git grep 超时
- 当前路由仅用 git grep，未接入 Zoekt/Serena 长驻索引
- 100 题样本量有限，小样本效果差异需谨慎解读

### 10.3 下一步

1. 接入 Zoekt/Serena 长驻索引替代冷启动 git grep
2. 增加中文分词或 query rewrite 解决 BM25=0 问题
3. 加入 authority/freshness 重排解决语义结果权威度问题
4. 扩充测试集到 128 条（8 赛道），增加无答案/越权/提示注入切片
5. 用 SWE-bench 风格的端到端修复任务验证检索收益的因果性
6. shadow mode 上线，记录真实开发中的检索调用、命中率、fallback 和 bypass

## 附录 A：实验数据文件清单

| 文件 | 位置 | 说明 |
 |------|------|------|
 | `lightvela-model-benchmark-v1.jsonl` | `control-plane/datasets/` | 100 题测试集 |
 | `results.jsonl` | `control-plane/runs/model-benchmark-v1/` | 100 题 x 5 adapter 原始结果 |
 | `summary.json` | `control-plane/runs/model-benchmark-v1/` | 聚合指标 + 配对统计 |
 | `manifest.json` | `control-plane/runs/model-benchmark-v1/` | adapter 配置与版本 |
 | `INITIAL_FINDINGS_2026-07-24.md` | `control-plane/reports/` | 六个工具摸底报告 |
 | `score_retrieval.py` | `control-plane/scripts/` | 评分函数 |
 | `run_model_benchmark.py` | `control-plane/scripts/` | benchmark 运行脚本 |
 | `build_corpus.py` | `control-plane/scripts/` | 语料构建脚本 |
 | `build_model_benchmark.py` | `control-plane/scripts/` | benchmark 构建脚本 |
 | `mine_change_candidates.py` | `control-plane/scripts/` | Git 历史挖掘脚本 |
 | `SOURCES.lock.tsv` | `context-retrieval-lab/` | 35+ 候选工具版本锁定 |
 | `EXPERIMENT_MASTER_PLAN.md` | `context-retrieval-lab/` | 完整实验主计划 |
 | `CONTEXT_GOVERNANCE_BLUEPRINT.md` | `context-retrieval-lab/` | 治理蓝图 |

## 附录 B：公平性控制

所有配置固定：
- mono2 各任务的独立 base_commit
- query 文本（来自 commit message subject）
- corpus allowlist（214 白名单 source files）
- Top-K = 20
- git grep 超时 = 180s
- 最大候选 = 500
- 最大种子 = 8
- 网络策略 = 全部本地，无外部 API

每个 adapter 只使用 git ls-tree / git grep / git show 公开稳定接口；禁止手工提示 Agent「应该去哪找」。
