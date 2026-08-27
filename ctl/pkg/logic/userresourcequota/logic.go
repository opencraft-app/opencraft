// Package userresourcequota ...
package userresourcequota

import (
	"ctl/pkg/config"
)

const (
	resourceNameOpenclawInstance = "OPENCLAW_INSTANCE"
	ResourceNameWebsiteSite      = "WEBSITE_STATIC_SITE"
)

var (
	defaultQuotaTotalMap = map[string]int64{
		resourceNameOpenclawInstance: 5,
		ResourceNameWebsiteSite:      0, // 默认0，由套餐配置决定
	}
)

// Quota ...
type Quota struct {
	Available int64
	Total     int64
}

// Logic ...
type Logic interface {
	ValidUserResourceName(name string) bool
}

// NewLogic ...
func NewLogic() Logic {
	return &logic{}
}

type logic struct{}

func (l *logic) ValidUserResourceName(name string) bool {
	if config.ServerConf.GlobalQuotaConfig != nil {
		for _, resourceName := range config.ServerConf.GlobalQuotaConfig.ValidModifyResourceNames {
			if resourceName == name {
				return true
			}
		}
	}

	_, ok := defaultQuotaTotalMap[name]
	return ok
}
