# `/feai-prd` 决策点选项定义

> 本文件定义每个需要用户决策的环节的 `ask_followup_question` 调用参数。
> 正文输出只承载上下文（草稿预览、检查报告、影响评估结论），**真正的选择交互一律通过 `ask_followup_question` 工具弹出图形化多选**，禁止让用户手动打字回复编号。

---

## 模板选择

- 触发：Step 1（用户未传 `--template`）。
- `options` 优先放「轻量」前缀标准模板的 top 3，其余收进「查看全部模板」。

```json
{
  "title": "选择需求模板",
  "questions": [
    {
      "header": "需求模板",
      "question": "使用哪个模板创建需求单？",
      "options": [
        { "label": "{模板名}", "description": "{description}" },
        { "label": "{模板名}", "description": "{description}" },
        { "label": "{模板名}", "description": "{description}" },
        { "label": "查看全部模板", "description": "展开完整模板列表" }
      ]
    }
  ]
}
```

> 用户选「查看全部模板」后，再输出完整列表追问（可继续用 `ask_followup_question`，或让用户点选具体项）。

---

## 迭代选择

- 触发：Step 4。
- `options`：需求池（推荐）/ 本周迭代 / 不关联迭代。

```json
{
  "title": "选择迭代",
  "questions": [
    {
      "header": "迭代",
      "question": "需求归属哪个迭代？",
      "options": [
        { "label": "{需求池名}（推荐，未锁定）", "description": "{begin}~{due}" },
        { "label": "{本周迭代名}", "description": "已锁定，排到本周" },
        { "label": "不关联迭代", "description": "TAPD 显示「未规划」" }
      ]
    }
  ]
}
```

> 存在多个候选迭代时，把最相关的前 3 个放进 `options`，其余收进「其他迭代」。

---

## 字段确认

- 触发：Step 3.5。
- 先用正文输出完整草稿预览，再用 `ask_followup_question` 确认。

```json
{
  "title": "确认需求草稿",
  "questions": [
    {
      "header": "字段确认",
      "question": "草稿如上，是否确认？",
      "options": [
        { "label": "确认，进入下一步", "description": "接受当前预填值" },
        { "label": "需要修改", "description": "指出要修改的字段" }
      ]
    }
  ]
}
```

> 用户选「需要修改」后，输出字段列表让用户指出目标字段与修改内容。

---

## 质量检查结果

- 触发：Step 5。
- 正文先输出检查报告，再用 `ask_followup_question` 选择后续动作。

```json
{
  "title": "质量检查结果",
  "questions": [
    {
      "header": "下一步",
      "question": "检查结论：{通过 / 有条件通过 / 打回}，如何处理？",
      "options": [
        { "label": "直接提交", "description": "接受当前质量" },
        { "label": "回到修改", "description": "回到字段确认修改" }
      ]
    }
  ]
}
```

结论→默认推荐映射：

| 结论 | 默认推荐 | 说明 |
|---|---|---|
| 通过 | 直接提交 | 无 blocker 且无 major |
| 有条件通过 | 回到修改 | 存在 major，提交前建议补齐 |
| 打回 | 回到修改 | 存在 blocker，选「直接提交」需二次确认 |

> 「打回」时，用户选「直接提交」需再弹一次确认：「确认强制提交」。

---

## 创建失败重试

- 触发：Step 6 字段校验错误。

```json
{
  "title": "创建失败",
  "questions": [
    {
      "header": "重试",
      "question": "以下字段需要修正：{字段列表}，是否修正后重试？",
      "options": [
        { "label": "修正后重试", "description": "回到字段确认，定位出错字段" },
        { "label": "结束", "description": "放弃本次创建" }
      ]
    }
  ]
}
```

> 最多重试 2 次。

---

## 衔接研发

- 触发：Step 6 创建成功。

```json
{
  "title": "需求创建成功",
  "questions": [
    {
      "header": "后续动作",
      "question": "Story {短 ID} 已创建，是否立即进入开发？",
      "options": [
        { "label": "立即进入开发", "description": "调用 /feai-start {完整 Story ID}" },
        { "label": "结束", "description": "稍后手动运行 /feai-start" }
      ]
    }
  ]
}
```
