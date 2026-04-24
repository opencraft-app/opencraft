// Package factory 提供适配器工厂，统一管理外部服务适配器的创建。
// 新增外部服务适配器时，在此工厂中注册对应的创建方法。
package factory

import (
	"ctl/pkg/adapter/aigateway"
	"ctl/pkg/adapter/client"
	"ctl/pkg/adapter/openclawgateway"
	"ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
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
	AiGatewayAdapter() aigateway.Adapter
	OpenClawGatewayAdapter() openclawgateway.Adapter
	ShadowAdapter() shadow.Adapter
}

// DefaultAdapterFactory 默认适配器工厂实例
var DefaultAdapterFactory AdapterFactory = new(adapterFactory)

type adapterFactory struct {
	sandboxOnce         sync.Once
	sandbox             sandbox.Adapter
	aigatewayOnce       sync.Once
	aigateway           aigateway.Adapter
	openclawGatewayOnce sync.Once
	openclawGateway     openclawgateway.Adapter
	shadowOnce          sync.Once
	shadowAdapter       shadow.Adapter
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
			}
		}
		f.shadowAdapter = shadow.NewShadowAdapter(cfg, resource.ZapLogger)
	})
	return f.shadowAdapter
}

// NewClientConfig 创建通用的 HTTP 客户端配置
// 所有 Adapter 都可以复用此配置
func NewClientConfig() *client.Config {
	return client.NewConfig()
}
