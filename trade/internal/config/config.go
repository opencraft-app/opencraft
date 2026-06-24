package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"git.woa.com/wisp/mono/trade/internal/region"
)

// Config 集中管理 trade 服务运行时配置。
//
// 与设计稿 §3.2 / §3.5.5 / §6.4 等章节对齐：
//   - InternalServiceToken：lightclaw 内部服务间互信 token（与 payment / subscription 共享同一密钥）
//   - CtlInternalBaseURL：trade → ctl 反向调（Q33 GetInternalBundleByID / 复活 createResource 链路用）
//   - AccountBindingInternalBaseURL：trade → auth 反向调（Q12 / Q30 externalUserId → uin/appId 绑定）
//   - JifeiCGWGatewayURL / JifeiCGWHostHeader：jifei CGW 询价 / 下单 / 退款响应等所有出向请求统一入口（Q51 / §3.5.5）
//   - **JifeiCGWXQCloudUserID（v1.7.4 新增）**：jifei CGW 出向请求的 `x-qcloud-user-id` header 值；
//     **仅测试环境需要带**（测试 uin 如 `700000164995`，由 jifei 同事提供），现网由部署侧出口 IP 鉴权
//     无需带；为空字符串时 jifeiclient 跳过 header 注入。
//   - **JifeiBillingAPIGWURL / JifeiBillingAppID / JifeiBillingAppSecret（销毁链路 Q-D-SIG-1~6 新增）**：
//     jifei 计费网关测试/现网入口 + appid + appSecret，用于销毁链路
//     `qcloud.operation.ModifyResourceStatus` HMAC-SHA256 签名（与上面 jifei-test CGW 路由的不签名
//     询价/下单接口严格区分）。三者通过 SSM + sops 注入到 trade env，**禁止入 Git 明文**。
//   - JifeiCallbackSignatureKey：jifei → trade 回调验签密钥（Q13 checkCreate signature 校验；与 Q47
//     trade → jifei 请求方向不签名严格区分两个签名方向）
//   - JifeiComponentName / JifeiProtocolVersion：trade 出口 PDF framework 出参（Q58）固定字段，
//     jifei 侧按 PDF 协议解析 framework 双层结构；componentName 默认 `"trade"`，version 默认 `"1.0"`，
//     联调期可按 jifei 同事 align 结果 override；具体语义见 .tmp/trade-purchase-flow-design.md Q58。
//   - JifeiOurInterfacePrefix：jifei → trade 回调入参三段式 `interfaceName` 第一段（业务前缀）；
//     默认 `"lightvela"`，dispatcher 层（Q60）按它校验 `lightvela.pass.checkCreate` /
//     `lightvela.pass.createResource` 等是否属于 trade 自家路由。
//   - **SiteKind（v1.7.x 国际站接入新增）**：trade 服务部署站点标识。
//     取值：
//   - "cn"   → 国内站（缺省值）
//   - "intl" → 国际站
//   - 其他值 → 缺省按国内站处理（兼容性兜底）
//     由环境变量 `LIGHTVELA_SITE_KIND` 注入，与 ctl / shadow / sandbox 保持一致语义
//     （[memory:ztcm1utv] 各服务独立读自己的 env，trade 不跨服务透传）。该值贯穿
//     `jifeiclient.Options.SiteKind`（A3）/ `jifei.Adapter.Deps.SiteKind`（A6.1）/
//     `placeorder.Deps.SiteKind`（A6.1）/ `inquiry.Deps.SiteKind`（A6.1）/
//     `destroyresource.Deps.SiteKind` 等 7 处下游注入点（v1.1 设计稿 §3.1 A6.3）。
//     与 jifei envelope 出向 PDF 协议字面量 `"1"` / `"2"` 的映射只在 jifeiclient
//     `makeExtraPara` 一处发生（B-PROTO-5），trade 内部其他位置一律用 `"cn"` / `"intl"`
//     语义字面量。
//
// 环境变量命名遵循 monorepo 既有约定：
//   - TRADE_*：trade 服务私有
//   - LIGHTCLAW_*：跨服务通用
type Config struct {
	Addr     string
	MySQLDSN string

	InternalServiceToken          string
	CtlInternalBaseURL            string
	AccountBindingInternalBaseURL string

	JifeiCGWGatewayURL        string
	JifeiCGWHostHeader        string
	JifeiCGWXQCloudUserID     string // v1.7.4 新增 — 仅测试环境带，现网空
	JifeiCallbackSignatureKey string

	// 销毁链路（Q-D-SIG-1~6）jifei 计费网关签名三件套；空字符串时销毁链路调用
	// jifeiclient.ModifyResourceStatus 会因签名前置校验失败而报错，但 trade 启动
	// 不强校验（与 JifeiCGWGatewayURL 同范式 — 联调期允许部分功能未配置）。
	JifeiBillingAPIGWURL  string // jifei 计费网关 ModifyResourceStatus 入口 URL
	JifeiBillingAppID     string // jifei 计费网关分配的 appid
	JifeiBillingAppSecret string // jifei 计费网关分配的 appSecret（HMAC-SHA256 签名密钥；通过 SSM + sops 注入）

	// Q58 出口 framework 双层结构必填项；Q60 dispatcher 入参三段式校验前缀。
	JifeiComponentName      string
	JifeiProtocolVersion    string
	JifeiOurInterfacePrefix string

	// SiteKind 是部署站点标识（v1.7.x 国际站接入新增），由环境变量
	// `LIGHTVELA_SITE_KIND` 注入，缺省 / 非法值兜底为 "cn"。详见上方包级注释。
	SiteKind string

	// RegionOverride 是 trade 出向 jifei 协议字段 region 的运行时 override（北京 2 预发布
	// 接入 2026-06-12 新增）。取值为腾讯云 region 字面量（kebab-case 全小写），例：
	//   - "ap-guangzhou" → 1 / 100001 / "广州"
	//   - "ap-beijing"   → 8 / 800001 / "北京"
	//   - "ap-singapore" → 9 / 900001 / "Singapore"
	//
	// 取值优先级：override 非空且命中 region.regionTable 时优先于 SiteKind 兑底；空字符串
	// 时按 SiteKind 走（cn → 广州 / intl → 新加坡）。注册表唯一来源在 trade/internal/region
	// 包，新增地域只需在 region.regionTable 加一行，调用方零感知。
	//
	// 由环境变量 `LIGHTVELA_TRADE_REGION` 注入，未注册字面量在 Load() 期 fail-fast。
	// 该值贯穿与 SiteKind 同样的 7 处下游 Deps 注入点。
	RegionOverride string

	// 点石活动接入（设计稿 .tmp/dianshi-activity-bundle-design.md §5.1 / §8）：
	//   - DianshiPriceBaseURL：clgateway dianshi-price route 入口（env DIANSHI_PRICE_BASE_URL）
	//   - DianshiOrderBaseURL：clgateway dianshi-order route 入口（env DIANSHI_ORDER_BASE_URL）
	//
	// 两者同进同退：都为空时 main.go 不装配 ActivityResolver / DianshiClient，
	// inquiry / placeorder / createresource 完全退化到 v1.7.x 历史行为（jifei 单路径）。
	// 两者部分缺失（只配一个）会被 Load 期列为配置错误（避免只能询价却不能下单的跳脚状态）。
	DianshiPriceBaseURL string
	DianshiOrderBaseURL string
}

// Load 从环境变量构建 Config，未设必填项时返回 error。
func Load() (Config, error) {
	cfg := Config{
		Addr: envOrDefault("TRADE_ADDR", ":8080"),
		MySQLDSN: firstNonEmpty(
			strings.TrimSpace(os.Getenv("TRADE_MYSQL_DSN")),
			buildMySQLDSN(
				envOrDefault("TRADE_DB_USER", "trade"),
				strings.TrimSpace(os.Getenv("TRADE_DB_PASSWORD")),
				envOrDefault("MYSQL_HOST", "127.0.0.1"),
				envOrDefault("MYSQL_PORT", "3306"),
				strings.TrimSpace(os.Getenv("TRADE_DB")),
			),
		),
		InternalServiceToken: strings.TrimSpace(os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN")),
		CtlInternalBaseURL:   strings.TrimSpace(os.Getenv("CTL_INTERNAL_BASE_URL")),
		AccountBindingInternalBaseURL: firstNonEmpty(
			strings.TrimSpace(os.Getenv("ACCOUNT_BINDING_INTERNAL_BASE_URL")),
			strings.TrimSpace(os.Getenv("SHADOW_INTERNAL_BASE_URL")),
		),
		JifeiCGWGatewayURL:        strings.TrimSpace(os.Getenv("JIFEI_CGW_GATEWAY_URL")),
		JifeiCGWHostHeader:        strings.TrimSpace(os.Getenv("JIFEI_CGW_HOST_HEADER")),
		JifeiCGWXQCloudUserID:     strings.TrimSpace(os.Getenv("JIFEI_CGW_X_QCLOUD_USER_ID")),
		JifeiCallbackSignatureKey: strings.TrimSpace(os.Getenv("TRADE_TENCENT_BILLING_SIGNATURE_KEY")),

		// 销毁链路（Q-D-SIG-1~6）jifei 计费网关签名三件套
		JifeiBillingAPIGWURL:  strings.TrimSpace(os.Getenv("JIFEI_BILLING_APIGW_URL")),
		JifeiBillingAppID:     strings.TrimSpace(os.Getenv("JIFEI_BILLING_APP_ID")),
		JifeiBillingAppSecret: strings.TrimSpace(os.Getenv("JIFEI_BILLING_APP_SECRET")),

		// Q58 / Q60 dispatcher + builder 默认值（联调期按 jifei align 后再 override）
		JifeiComponentName:      envOrDefault("TRADE_JIFEI_COMPONENT_NAME", "trade"),
		JifeiProtocolVersion:    envOrDefault("TRADE_JIFEI_PROTOCOL_VERSION", "1.0"),
		JifeiOurInterfacePrefix: envOrDefault("TRADE_JIFEI_OUR_INTERFACE_PREFIX", "lightvela"),

		// v1.7.x 国际站接入：站点标识 env 解析（兼容性兜底见 normalizeSiteKind）
		SiteKind: normalizeSiteKind(os.Getenv("LIGHTVELA_SITE_KIND")),

		// 北京 2 预发布接入（2026-06-12）：region 字段 override，未配则按 SiteKind 兜底
		RegionOverride: strings.TrimSpace(os.Getenv("LIGHTVELA_TRADE_REGION")),

		// 点石活动接入（设计稿 §8）：两个 env 同进同退；都为空时 main.go 不装配 Resolver/DianshiClient。
		DianshiPriceBaseURL: strings.TrimSpace(os.Getenv("DIANSHI_PRICE_BASE_URL")),
		DianshiOrderBaseURL: strings.TrimSpace(os.Getenv("DIANSHI_ORDER_BASE_URL")),
	}
	if cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("TRADE_MYSQL_DSN is required")
	}
	cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)

	if cfg.InternalServiceToken == "" {
		return Config{}, fmt.Errorf("LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required")
	}
	if cfg.CtlInternalBaseURL == "" {
		return Config{}, fmt.Errorf("CTL_INTERNAL_BASE_URL is required")
	}
	if cfg.AccountBindingInternalBaseURL == "" {
		return Config{}, fmt.Errorf("ACCOUNT_BINDING_INTERNAL_BASE_URL is required")
	}
	// LIGHTVELA_TRADE_REGION fail-fast：未注册 region 字面量会让 trade 出向 jifei 协议
	// regionId 落零值被 800200 拒回，启动期直接拦截，避免运行时排障困难。
	if cfg.RegionOverride != "" {
		if _, ok := region.LookupByRegion(cfg.RegionOverride); !ok {
			return Config{}, fmt.Errorf(
				"LIGHTVELA_TRADE_REGION=%q is not a registered region; "+
					"supported: ap-guangzhou / ap-beijing / ap-singapore",
				cfg.RegionOverride)
		}
	}
	// 点石活动接入（设计稿 §5.8）：DIANSHI_PRICE_BASE_URL 与 DIANSHI_ORDER_BASE_URL
	// 必须同进同退——任一只配置一边都会让"能询价但下不了单 / 能下单却没询过价"的跛脚状态
	// 进入运行期，反而比两个都不配更危险（两者都为空 = main.go 不装配 ActivityResolver/
	// DianshiClient，inquiry / placeorder 完全退化到 v1.7.x 历史行为）。
	if (cfg.DianshiPriceBaseURL == "") != (cfg.DianshiOrderBaseURL == "") {
		return Config{}, fmt.Errorf(
			"DIANSHI_PRICE_BASE_URL and DIANSHI_ORDER_BASE_URL must be configured together "+
				"(price=%q, order=%q)",
			cfg.DianshiPriceBaseURL, cfg.DianshiOrderBaseURL)
	}
	// JifeiCGWGatewayURL / JifeiCGWHostHeader / JifeiCallbackSignatureKey 在迭代 3 / 5 真正接入
	// jifei CGW 适配层时再做强校验；当前迭代 1 骨架阶段允许为空，避免本地起服失败。
	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// normalizeSiteKind 把 LIGHTVELA_SITE_KIND env 字面量规范化为 trade 内部统一字面量。
//
// 取值表（v1.7.x 国际站接入）：
//   - "cn" / "CN" / "Cn" / 大小写组合       → "cn"
//   - "intl" / "INTL" / "Intl" / 大小写组合 → "intl"
//   - 其他（含空字符串、"bogus"、"sg" 等非法值）→ "cn"（B-COMPAT-1 兼容性兜底）
//
// 该函数仅做规范化，不做 fail-fast；非法值兜底到 "cn" 与 ctl / shadow / sandbox
// 既有行为对齐（[memory:ztcm1utv] 各服务独立读 env，缺省一致行为最重要）。
func normalizeSiteKind(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "intl":
		return "intl"
	default:
		return "cn"
	}
}

// parseBoolEnv 解析 env 为 bool；常见 truthy 值（"true"/"1"/"yes"/"on"，大小写不敏感）→ true，
// 其他（含空字符串、"false"、"0" 等）→ false。仅供 trade 内部使用，避免引入额外依赖。
func parseBoolEnv(key string) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch value {
	case "true", "1", "yes", "on":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func buildMySQLDSN(user, password, host, port, database string) string {
	if strings.TrimSpace(user) == "" || strings.TrimSpace(password) == "" || strings.TrimSpace(database) == "" {
		return ""
	}
	cfg := mysql.NewConfig()
	cfg.User = strings.TrimSpace(user)
	cfg.Passwd = strings.TrimSpace(password)
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%s", strings.TrimSpace(host), strings.TrimSpace(port))
	cfg.DBName = strings.TrimSpace(database)
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Params = map[string]string{"time_zone": "'+00:00'"}
	return cfg.FormatDSN()
}

func normalizeMySQLDSN(dsn string) string {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return ""
	}
	cfg, err := mysql.ParseDSN(trimmed)
	if err != nil {
		return trimmed
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN()
}
