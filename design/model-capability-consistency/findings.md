# 事实

- mapModels 首项默认、固定 image；model/list 没有读取明确 default。
- ModelDocument.defaultModel 可为 null；引擎 apply 当前 null 会跳过撤销默认。
- Composer 已有 reasoning capability compiler/resolver；此轮保持其语义。
- RuntimeModelView 的公共字段为 input，DSH 内部为 inputModalities；其 host 目录 API 会丢弃输入字段。通过既有 capability bridge 的窄 model-info 读取 resolved runtime facts，不修改依赖包。
- DSH default schema provider/model 必填：null 时 unset 适配器写入的用户层；内部 composition 默认仍存在但不进入产品目录或新任务创建。新任务必须明确选择/明确产品默认。
- 本机 model-info 初次真实验证 400，检查 injection 声明发现缺少 llm；补依赖声明后重新真实验收，不将未知错误当作成功。
