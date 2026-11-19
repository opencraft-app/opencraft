# BM25辅助索引实验

2026-11-09，用户要求先试。候选在独立runner实现，不部署Join；基线6dee728已含问题驱动词重合召回。

Markdown profile/log仍是事实权威。SqliteMemoryIndex在当前连接创建TEMP FTS5表和TEMP触发器，索引key＋正文；开连接从已有投影重建，再由原文件权威同步校正。原memory行的insert/update/delete在同一事务内维护FTS，回滚同时撤销；文件编辑、重建、遗忘沿既有owner。无main schema迁移或额外模型/向量依赖。FTS5不支持时初始化直接失败，不假装零命中。

内部自动recall的text沿用6000字符、24个去重非功能词，统一Intl.Segmenter词切分和小写；索引正文也使用相同分词后交FTS5 unicode61。MATCH将词逐个引用并以OR连接，BM25默认评分升序，再按更新时间和key稳定排序。scope过滤在LIMIT之前；可见范围内遗漏项目仍可能影响连接全语料的IDF统计，分数不作为业务置信度。先不调列权重、引入向量、扩写问题或按题目挑词。

这会从旧substring重合变成token命中＋BM25，不只是替换排序公式；例如photo不再命中photography，中文分词粒度也会影响召回。英文词形/同义词和隐含关系仍不保证，中文使用内置分词而非腾讯结巴，不能称逐字移植腾讯方案。

显式memory.search的literal/terms AND、文件读取、profile/recent预算、输入去重、来源/墓碑和scope契约均不变。策略元信息question-lexical-overlap仍表示词面召回，具体评分实现记录在本文件与运行版本。

成对评测按原17题/3人物，各因果前缀学习一次，候选与基线各以同一当前问题seed、读取同一事实；reader DeepSeek Flash、后台hy4 none、相同指令与预算，交替先后。只用于已知小样本回归；不能单凭分数宣称泛化提升。先运行机制/完整业务/评测回归，再从独立提交冻结新run。
