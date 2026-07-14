// Package factory 提供适配器工厂，统一管理外部服务适配器的创建。
// 新增外部服务适配器时，在此工厂中注册对应的创建方法。
package factory

import (
	"ctl/pkg/adapter/aigateway"
	"ctl/pkg/adapter/client"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/adapter/openclawgateway"
	"ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/config"
	"ctl/pkg/resource"
	"sync"
)

// AdapterFactory 适配器工厂接口
// 开发新业务时，在此接口中添加对应的 Adapter 方法声明，
// 并在 adapterFactory 结构体中实现。
type AdapterFactory interface {
	SandboxAdapter() sandbox.Adapter
	StsAdapter() sts.Adapter
	WhitelistAdapter() whitelist.Adapter
	LLMGatewayAdapter() llmgateway.Adapter
	OpenClawGatewayAdapter() openclawgateway.Adapter
	ShadowAdapter() shadow.Adapter
	TradeAdapter() trade.Adapter
}

// DefaultAdapterFactory 默认适配器工厂实例
var DefaultAdapterFactory AdapterFactory = new(adapterFactory)

type adapterFactory struct {
	sandboxOnce         sync.Once
	sandbox             sandbox.Adapter
	aigatewayOnce       sync.Once
	aigateway           aigateway.Adapter
	llmgatewayOnce      sync.Once
	llmgateway          llmgateway.Adapter
	openclawGatewayOnce sync.Once
	openclawGateway     openclawgateway.Adapter
	shadowOnce          sync.Once
	shadowAdapter       shadow.Adapter
	tradeOnce           sync.Once
	tradeAdapter        trade.Adapter
}

// SandboxAdapter ...
func (f *adapterFactory) SandboxAdapter() sandbox.Adapter {
	f.sandboxOnce.Do(func() {
		f.sandbox = sandbox.NewSandboxAdapter(config.ServerConf.AdapterConfig.Sandbox, resource.ZapLogger)
	})
	return f.sandbox
}

// StsAdapter ...
func (f *adapterFactory) StsAdapter() sts.Adapter {
	return nil
}

// WhitelistAdapter ...
func (f *adapterFactory) WhitelistAdapter() whitelist.Adapter {
	return nil
}

// AiGatewayAdapter ...
func (f *adapterFactory) AiGatewayAdapter() aigateway.Adapter {
	f.aigatewayOnce.Do(func() {
		f.aigateway = aigateway.NewAiGatewayAdapter(
			config.ServerConf.AdapterConfig.AiGateway, resource.ZapLogger)
	})
	return f.aigateway
}

// LLMGatewayAdapter ...
func (f *adapterFactory) LLMGatewayAdapter() llmgateway.Adapter {
	f.llmgatewayOnce.Do(func() {
		f.llmgateway = llmgateway.NewLLMGatewayAdapter(
			config.ServerConf.AdapterConfig.LLMGateway, resource.ZapLogger)
	})
	return f.llmgateway
}

func (f *adapterFactory) OpenClawGatewayAdapter() openclawgateway.Adapter {
	f.openclawGatewayOnce.Do(func() {
		f.openclawGateway = openclawgateway.NewAdapter(nil, resource.ZapLogger)
	})
	return f.openclawGateway
}

// ShadowAdapter ...
func (f *adapterFactory) ShadowAdapter() shadow.Adapter {
	f.shadowOnce.Do(func() {
		var cfg *shadow.Config
		if config.ServerConf.AdapterConfig != nil && config.ServerConf.AdapterConfig.Shadow != nil {
			cfg = &shadow.Config{
				BaseURL: config.ServerConf.AdapterConfig.Shadow.BaseURL,
				Token:   config.ServerConf.AdapterConfig.Shadow.Token,
				Timeout: config.ServerConf.AdapterConfig.Shadow.Timeout,
				Enabled: config.ServerConf.AdapterConfig.Shadow.Enabled,
			}
		}
		f.shadowAdapter = shadow.NewShadowAdapter(cfg, resource.ZapLogger)
	})
	return f.shadowAdapter
}

// TradeAdapter 返回 trade 服务适配器单例（billing-integration B2 新增）。
//
// 当 AdapterConfig.Trade 缺失时，仍构造一个空 cfg 的 adapter，
// 调用方实际触发请求时由 adapter 内部返回 "base_url not configured" 错误，
// 与 ShadowAdapter / AiGatewayAdapter 保持同样的兜底语义。
func (f *adapterFactory) TradeAdapter() trade.Adapter {
	f.tradeOnce.Do(func() {
		var cfg *trade.Config
		if config.ServerConf.AdapterConfig != nil && config.ServerConf.AdapterConfig.Trade != nil {
			cfg = &trade.Config{
				BaseURL: config.ServerConf.AdapterConfig.Trade.BaseURL,
				Token:   config.ServerConf.AdapterConfig.Trade.Token,
				Timeout: config.ServerConf.AdapterConfig.Trade.Timeout,
			}
		}
		f.tradeAdapter = trade.NewTradeAdapter(cfg, resource.ZapLogger)
	})
	return f.tradeAdapter
}

// NewClientConfig 创建通用的 HTTP 客户端配置
// 所有 Adapter 都可以复用此配置
func NewClientConfig() *client.Config {
	return client.NewConfig()
}
