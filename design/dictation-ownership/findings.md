# 写入与所有权不变量

- Draft/View/内容代次必须显式失效，禁止外部replace-content旧输入继续有效；物理写入拒绝必须返回失败，不能用识别文字非空推定写入成功。
- 明确适配：Core泛用瞬时selection提交保留；dictation提交选择append政策，绑定具体View后同步读回验证；Store/View分离需要显式boolean ack。
