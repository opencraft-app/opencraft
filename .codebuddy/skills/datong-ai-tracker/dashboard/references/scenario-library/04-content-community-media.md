# 内容社区与媒体场景

## 1. 场景定义

适用于内容消费、内容分发、社区互动、创作者生态、订阅媒体等场景。核心目标通常是消费深度、互动活跃、回访留存，以及在必要时的订阅/广告变现。

## 2. 仓库命中信号

- 实体：`article`、`video`、`post`、`feed`、`comment`、`creator`、`topic`、`subscription`
- 行为：浏览、播放、点赞、评论、分享、关注、发布、订阅
- 页面：Feed、内容详情、播放页、作者页、频道页

## 3. North Star 候选

优先候选：**每周完成高质量内容消费的用户数**；备选：人均内容消费次数 / 时长、每周高质量互动用户数。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 内容消费用户数 | 核心结果 | 有内容浏览/播放事件 | 统计周期内发生 `content_view` / `video_play_start` 的去重用户数 | `content_view` / `video_play_start` | `content_id`、`content_type`、`channel`、`author_id` |
| 内容消费次数 | 核心结果 | 内容消费是主业务 | 统计周期内内容消费事件总次数 | `content_view` / `video_play_start` | 建议区分“开始播放”和“有效播放” |
| 高质量消费用户数 | 核心结果 | 能定义有效消费阈值 | 满足预定义消费阈值的去重用户数 | `content_progress` / `content_complete` / 停留时长 | 阈值要固定，如滚动深度/播放时长 |
| 完成率 / 深度阅读率 | 核心结果 | 有进度或完成埋点 | `content_complete` 去重用户数 ÷ `content_view` 去重用户数；图文可用滚动深度≥阈值替代 | `content_view` + `content_complete` / `content_progress` | 长短内容可分开 |
| 互动率 | 核心结果 | 产品重社区互动 | 至少发生一次 `like` / `comment_submit` / `share` / `follow` 的去重用户数 ÷ 内容消费用户数 | 互动事件 + 内容消费事件 | 也可拆点赞率、评论率、分享率 |
| 回访率 / 留存率 | 核心结果 | 重视用户粘性 | 第 0 周内容消费用户中，在第 1 / 4 周再次内容消费的去重用户数 ÷ 第 0 周内容消费用户数 | 内容消费事件 + 用户 cohort | 内容场景通常按周看更稳 |
| 订阅转化率 | 核心结果 | 有订阅 / 会员产品 | `subscribe_success` 去重用户数 ÷ 订阅页访客数（或内容消费用户数，需固定） | `subscribe_view` + `subscribe_success` | 分母口径要固定 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| Feed 点击率 | 诊断 | 依赖分发流量 | `feed_item_click` 次数 ÷ `feed_item_impression` 次数 | `feed_item_impression` + `feed_item_click` | `feed_position`、`algorithm_bucket` |
| 搜索到消费转化率 | 诊断 | 搜索是核心入口 | 发生内容消费的去重用户数 ÷ 发起 `search` 的去重用户数（且需点击结果） | `search` + `search_result_click` + `content_view` | `query`、`content_id` |
| 分享率 | 诊断 | 分享带回流或传播 | `share` 去重用户数 ÷ 内容消费用户数 | `share` + 内容消费事件 | 回流率需额外 referral 数据 |
| 关注转化率 | 诊断 | 有创作者/频道生态 | `follow_author` / `subscribe_channel` 去重用户数 ÷ 作者页/频道页访客数 | `author_page_view` / `channel_view` + follow/subscribe | 适合 UGC / PGC |
| 播放失败率 | 护栏 | 音视频体验关键 | `video_play_error` 次数 ÷ `video_play_start` 次数 | `video_play_start` + `video_play_error` | 按 CDN、网络、机型拆分 |
| 投诉/举报率 | 护栏 | 社区治理重要 | `content_report` 次数 ÷ 内容消费次数 | `content_report` + 内容消费事件 | 适合社区/UGC |

## 5. 不要乱推

- 没有消费深度数据时，不要只拿 PV / 播放量当内容成功。
- 没有作者/频道生态时，不要乱推创作者指标。
- 没有订阅产品时，不要强推订阅转化。
