// Package website — custom domain binding DAO.
package website

import (
	"errors"
	"fmt"
	"strings"

	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

type CustomDomainDao interface {
	CreateBinding(entity *CustomDomainEntity) error
	GetByDomain(domain string) (*CustomDomainEntity, error)
	DeleteByDomain(domain string) error
	ListBySiteID(siteID string) ([]*CustomDomainEntity, error)
}

type customDomainDao struct {
	*model.BaseDao
}

func NewCustomDomainDao() CustomDomainDao {
	return &customDomainDao{BaseDao: model.NewBaseDao(CustomDomainsTable).SetKeyColumn("domain")}
}

// NormalizeDomain 归一化域名：去端口、小写、去尾点。
//
// 与 site-gateway 的 hostroute.normalizeHost 保持同一套规则，确保两端
// 用同一把键查表。
func NormalizeDomain(domain string) string {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return ""
	}
	// 去端口（IPv6 字面量场景极少，这里只处理常见的 host:port）
	if idx := strings.LastIndex(domain, ":"); idx >= 0 && !strings.HasPrefix(domain, "[") {
		domain = domain[:idx]
	}
	return strings.Trim(strings.ToLower(domain), ".")
}

func (d *customDomainDao) CreateBinding(entity *CustomDomainEntity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	entity.Domain = NormalizeDomain(entity.Domain)
	if entity.Domain == "" {
		return errors.New("domain is empty after normalization")
	}
	return resource.GormDB.Table(d.TableName).Create(entity).Error
}

func (d *customDomainDao) GetByDomain(domain string) (*CustomDomainEntity, error) {
	domain = NormalizeDomain(domain)
	if domain == "" {
		return nil, nil
	}
	var entity CustomDomainEntity
	err := resource.GormDB.Table(d.TableName).
		Where("domain = ?", domain).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get custom domain: %w", err)
	}
	return &entity, nil
}

func (d *customDomainDao) DeleteByDomain(domain string) error {
	domain = NormalizeDomain(domain)
	if domain == "" {
		return errors.New("domain is empty after normalization")
	}
	return resource.GormDB.Table(d.TableName).
		Where("domain = ?", domain).
		Delete(nil).Error
}

func (d *customDomainDao) ListBySiteID(siteID string) ([]*CustomDomainEntity, error) {
	var entities []*CustomDomainEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Order("created_time ASC, id ASC").
		Find(&entities).Error
	if err != nil {
		return nil, fmt.Errorf("list custom domains: %w", err)
	}
	return entities, nil
}
