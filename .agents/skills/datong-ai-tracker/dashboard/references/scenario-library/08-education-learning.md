# 教育与学习产品场景

## 1. 场景定义

适用于在线课程、企业学习、培训平台、学习型社区。核心目标通常是开课、学习进度、完成率、通过率、复学/留存，以及识别高风险学员。

## 2. 仓库命中信号

- 实体：`course`、`lesson`、`chapter`、`assignment`、`quiz`、`exam`、`progress`、`grade`
- 行为：报名、开始课程、观看课时、提交作业、参加考试、完成课程、领证
- 页面：课程页、章节页、作业页、考试页、进度页

## 3. North Star 候选

优先候选：**课程完成人数 / 完成率**；备选：有效活跃学员数、通过/达标人数。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 报名人数 | 核心结果 | 有课程报名行为 | 统计周期内完成 `course_enroll_success` 的去重学员数 | `course_enroll_success` | `learner_id`、`course_id`、`channel`、`org_id` |
| 首课启动率 | 核心结果 | 报名后常在首课流失 | 报名后 X 天内开始第一课的学员数 ÷ 报名学员数 | `course_enroll_success` + `lesson_start` | 需定义“第一课” |
| 活跃学员数 | 核心结果 | 关注过程参与 | 统计期内发生学习行为的去重学员数 | `lesson_start` / `lesson_complete` / `assignment_submit` / `quiz_submit` | 先固定学习活跃口径 |
| 课程完成率 | 核心结果 | 有 completion 定义 | 完成课程的学员数 ÷ 报名开课学员数 | `course_complete` + `course_enroll_success` | 建议按课程/班级分开 |
| 学习进度达成率 | 核心结果 | 有进度表 | 当前进度达到目标阈值的学员数 ÷ 在学学员数 | progress 表 / `lesson_complete` | `progress_percent` |
| 考试通过率 | 核心结果 | 有测验/考试 | 通过考试的学员数 ÷ 参加考试的学员数 | `exam_submit` / `quiz_submit` + `exam_pass` | 需明确及格线 |
| 回访率 / 留存率 | 核心结果 | 产品学习周期较长 | 第 0 周开始学习的学员中，在第 1 / 4 周仍有学习行为的学员数 ÷ 第 0 周 cohort | 报名 / first lesson + 学习活跃事件 | 建议按周看 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 作业提交率 | 诊断 | 有作业机制 | 提交作业的学员数 ÷ 有作业要求的学员数 | `assignment_assigned` + `assignment_submit` | `assignment_id`、截止时间 |
| 学习时长 | 诊断 | 过程时长有意义 | 总学习时长 / 活跃学员数，或人均学习分钟数 | `lesson_start` + `lesson_end` / heartbeat | 长内容建议用心跳 |
| 互动参与率 | 诊断 | 有论坛/讨论/问答 | 发生讨论 / 问答 / 评论的学员数 ÷ 活跃学员数 | `forum_post` / `comment_submit` / `live_interaction` | 适合社群学习 |
| 高风险学员数 | 护栏 | 需要督学 | 满足“连续 N 天未学习 / 进度落后 / 作业逾期 / 成绩低于阈值”的学员数 | progress 表 + 访问日志 + assignment / exam 数据 | 必须先固定 risk rule |
| 逾期作业率 | 护栏 | 有截止日期 | 超时未提交的作业数 ÷ 应提交作业数 | 作业表 + `assignment_submit` | `due_time`、`submitted_at` |
| 内容未打开率 | 护栏 | 关心课程供给有效性 | 在统计期内从未被打开的课程/章节数 ÷ 已发布课程/章节数 | 内容发布表 + `lesson_start` / `content_open` | 适合课程供给评估 |

## 5. 不要乱推

- 没有 completion / progress 模型时，不要假装已经能做学习效果分析。
- 不要只看浏览量，忽略课程完成、作业、考试这些关键结果。
- 没有考试 / 成绩体系时，不要强推通过率、达标率。
