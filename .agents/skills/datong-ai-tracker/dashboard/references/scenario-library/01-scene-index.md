# 场景总索引

| 场景 | 何时加载 | 典型信号 | 可叠加副场景 | 文件 |
|---|---|---|---|---|
| 通用产品增长 | 还不能明确归到垂直行业，但已能看到注册-激活-活跃-留存主线 | signup、login、session、feature_used、retention | 市场投放 / 内容社区 / SaaS | `02-generic-product-growth.md` |
| 电商与零售 | 商品、购物车、订单、支付、履约明显 | product、sku、cart、order、payment、refund | 市场投放 | `03-ecommerce-retail.md` |
| 内容社区与媒体 | 内容消费、互动、分享、关注、订阅明显 | article、video、feed、comment、share、follow | 通用产品增长 | `04-content-community-media.md` |
| SaaS 与订阅 / B2B | workspace、seat、trial、subscription、billing 明显 | workspace、plan、invoice、subscription | 销售 CRM / 市场投放 | `05-saas-subscription-b2b.md` |
| 市场投放与增长营销 | 渠道、campaign、landing、spend、attribution 明显 | utm、campaign、creative、landing_page | 电商 / SaaS / FinTech | `06-marketing-acquisition.md` |
| 销售线索与 CRM | lead、MQL/SQL、pipeline、deal 明显 | lead、opportunity、deal、stage | SaaS | `07-sales-crm.md` |
| 教育与学习产品 | 课程、章节、作业、考试、进度明显 | course、lesson、assignment、quiz、progress | 通用产品增长 | `08-education-learning.md` |
| 游戏与 LiveOps | session、level、iap、currency、活动明显 | level、mission、iap、ad_revenue、event_pass | 市场投放 | `09-gaming-liveops.md` |
| 金融理财与支付 | KYC、绑卡/绑银行、交易、支付、风控明显 | kyc、bank_link、wallet、transaction、fraud | 市场投放 | `10-fintech-payments.md` |
| 客服与服务运营 | ticket、SLA、reply、resolved、CSAT 明显 | ticket、queue、agent、sla、csat | 通用产品增长 | `11-support-service-ops.md` |

## 读取策略

- 默认只读 **1 个主场景**
- 若第二高场景与主场景强相关，再读 **1 个副场景**
- 不要同时读 3 个以上场景文件，否则很容易把指标推散
