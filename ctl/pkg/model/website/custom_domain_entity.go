// Package website — custom domain binding entity.
//
// 随机子域靠 hostroute 字符串截取推导 siteID，不需要存映射。自定义域名
// （如 blog.example.com）无法从 Host 推导，必须有 domain→site_id 的映射表。
//
// domain 在写入前归一化（小写、去尾点），保证全局唯一。一个站点可以绑
// 多个域名（一行一条），一个域名只能属于一个站点（唯一键）。
package website

import "ctl/pkg/model"

const (
	CustomDomainsTable = "website_custom_domains"
)

// CustomDomainEntity 映射 website_custom_domains 表。
type CustomDomainEntity struct {
	model.BaseEntity
	model.BaseUserEntity

	Domain string `gorm:"column:domain"`
	SiteID string `gorm:"column:site_id;index:idx_site_id"`
}

func (CustomDomainEntity) TableName() string {
	return CustomDomainsTable
}
