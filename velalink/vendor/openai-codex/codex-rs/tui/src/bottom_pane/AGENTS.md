# TUI bottom pane（状态机）

修改本目录的 paste-burst 或 chat-composer state machine 时，保持文档同步：

- 更新相关 module doc（`chat_composer.rs` 和/或 `paste_burst.rs`），使其仍是对当前行为可读的自顶向下说明。
- behavior/assumption 变化时更新叙述性文档 `docs/tui-chat-composer.md`（Enter handling、retro-capture、flush/clear rule、`disable_paste_burst`、non-ASCII/IME handling）。
- 除非差异是有意为之且已记录，否则保持 implementation/docstring 一致。

实用检查：

- 编辑后，sanity-check 文档仅提及代码中存在的 API/behavior（尤其是 Enter/newline path 和 `disable_paste_burst` 语义）。
