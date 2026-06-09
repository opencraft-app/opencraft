# Skills 覆盖目录（Overrides）

> 🎯 用于"优雅覆盖"工具默认提供的 Skill。
> 在此目录下放置与 `team-extensions/` 同名的 `.md` 文件，工具升级时会自动跳过对应文件的同步。

## 与 user-custom/ 的区别

| 目录 | 用途 | 文件命名 | 工具升级行为 |
|------|------|---------|------------|
| `user-custom/` | 全新自定义 Skill | 任意命名（建议加前缀） | 永远保留 |
| `overrides/` 🎯 | **覆盖工具默认 Skill** | **必须与原文件同名** | 跳过同名文件同步 |

## 使用方式

### 场景：你想自定义工具默认的 `cr-check.md`

**做法 1：完全替代（推荐用 overrides）**
```bash
# 1. 复制工具默认版本
cp .codebuddy/skills/team-extensions/cr-check.md .codebuddy/skills/overrides/cr-check.md

# 2. 编辑你的版本
vim .codebuddy/skills/overrides/cr-check.md

# 3. 下次 feai update 时，team-extensions/cr-check.md 不会被覆盖
#    AI 工具会优先读取 overrides/cr-check.md
```

**做法 2：完全独立的 Skill（用 user-custom）**
```bash
# 创建你团队专属的新 Skill
vim .codebuddy/skills/user-custom/mygroup-react-rules.md
```

## ⚠️ 重要约束

1. **文件名必须与 `team-extensions/` 中的某个文件完全一致**（包括大小写）
2. 一旦放置了 `overrides/cr-check.md`，**工具升级永远不会再改动 `team-extensions/cr-check.md`**
3. 如果你想恢复默认行为，**删除 overrides 中对应文件**即可（下次升级会自动同步默认版本）

## 优先级关系

```
AI 读取顺序（高优先级 → 低优先级）：
  user-custom/<file>.md       (你的全新自定义)
    ↓
  overrides/<file>.md         (你的默认 Skill 覆盖版)
    ↓
  team-extensions/<file>.md   (工具默认版)
    ↓
  superpowers/<file>.md       (工具核心版)
```
