# Journey：订阅购买与续费

## 目标

用户选择套餐、完成支付并获得对应权益；续费、重复回调和中途失败不产生重复订单、重复权益或未付费开通。

## 链路

1. `frontend` 展示 `subscription` 返回的套餐/当前权益并发起购买或续费。
2. 公共请求经 `service-gateway` 到 `trade`/`payment`。
3. `trade` 创建订单并通过 provider 或 `cloudladdergateway` 调用外部计费。
4. `payment` 处理支付侧 contract/回调，使用稳定外部标识保证幂等。
5. `subscription` 应用支付结果并更新订阅、Pass 和配额。
6. 需要实例/能力开通时，只有 contract 成功后才调用 `ctl`。

## 失败与补偿

- 支付页面创建失败：不得提前应用权益。
- 回调重复/乱序：按外部订单标识幂等处理。
- 权益应用失败：保留可重试状态，不重复创建外部订单。
- CTL 开通失败：订单/支付事实不可丢失，补偿与重试单独记录。

## Pass 升配 Web checkout

- 账号页和定价页仅对后端返回的合法 Bundle 关系展示升级入口与选择联动；展示资格不能代替 CTL 下单前的 owner、Pass 状态和目标校验。
- Web 升配入口由 `frontend/src/lib/pass-upgrade-rollout.ts` 集中控制灰度：国内正式站仅指定验收账号可见，国际正式站关闭，明确列出的本地与北京前端测试域名允许登录用户验证。账号页、定价页、订单恢复与升级弹窗共用该判断；这是 UI 发布开关，不替代后端授权。正式验收通过后再独立调整开放范围。
- `GET /v1/passes/{pass_id}/modify/bundles` 返回实时差价；`POST .../modify/order` 只创建订单并返回 `deal_name`、`big_order_id` 和可选支付票据。
- `POST .../modify/order-url` 接收原 `deal_names` 获取支付链接，不再创建订单。微信桥使用绑定用户、Pass、订单的短期票据；`POST .../modify/payment-authorization` 仅供已登录本人重签原订单票据。
- `GET .../modify/checkout` 只读已落库的未结束订单；无订单不能证明上游建单未发生，多笔候选返回冲突。前端仅保存非敏感订单标识，刷新或换设备后续接原订单；明确取消的本地终态可释放记录，未知结果不能自动重下。
- 对齐新购两步式流程：客户端防连点、复用已落库订单；不承诺跨设备并发建单 exactly-once。升级交付仍使用现有 Pass slot/CAS 与 flow 幂等，不新增数据库锁或迁移。
- 支付接口只允许 `pending_pay` 的 modify 单，并验证用户、资源、订单类型和合法目标；不复用新购/续费的 deal-only 支付链接缓存。国际站使用 hosted payment，国内站使用微信桥接。
- 成功条件为同一 modify 订单 `local_status=provisioned`、统一状态 `success`，并且该用户的同一 Pass 已成为目标 Bundle 且 `status=active`。收到付款状态不是升级完成。

## 验证

成对验证订单、支付、订阅和 CTL 各阶段的成功/失败记录；线上金额、活动、API 地址和签名规则必须从登记的外部 authority 现场确认。
