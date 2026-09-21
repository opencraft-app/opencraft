# 对照与不变量

- get-model-picker-power-slider-impl.js: appendTextToComposer捕获具体controller；appendTextAndSubmit先append，再ke(controller.getText)，受提交阻塞pe约束。
- create-composer-editor-module-08745.ts: getText读取this.view.state.doc；appendText trim、必要空格、选择文末、插入、文末selection、同步dispatch。不是本产品“原选区replacement”的语义。
- getCachedDictationState: stop时具体handlers随request固化，currentRequestRef引用相等才清理，避免旧request清新状态；卸载与retry源行为不能无条件照搬我们的取消策略。
- 本产品需保留比恢复源码更明确的Draft/View/内容代次失效，禁止外部replace-content旧输入继续有效；物理写入拒绝必须返回失败，不能用识别文字非空推定写入成功。
- 明确适配：Core泛用瞬时selection提交保留；dictation提交选择append政策，绑定具体View后同步读回验证；Store/View分离需要显式boolean ack，不称原类体/接口100%复制。
