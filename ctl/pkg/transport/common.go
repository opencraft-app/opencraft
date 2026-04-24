// Package transport ...
package transport

import (
	"fmt"
)

const (
	DefaultLimit = 20

	LanguageZhCn = "zh-CN"
	LanguageEnUs = "en-US"
)

// CommonListParams ...
type CommonListParams struct {
	Offset int64 `validate:"omitempty,min=0"`
	Limit  int64 `validate:"omitempty,min=0"`

	OrderBy string
	Order   string
}

// NewDefaultCommonListParams ...
func NewDefaultCommonListParams() *CommonListParams {
	return &CommonListParams{
		Offset:  0,
		Limit:   DefaultLimit,
		OrderBy: "id",
		Order:   "desc",
	}
}

// MysqlOrderBy ...
func (p *CommonListParams) MysqlOrderBy() string {
	return fmt.Sprintf("%s %s", p.OrderBy, p.Order)
}

// InstanceIdentifier ...
type InstanceIdentifier struct {
	Region     string `validate:"required,lighthouse_region"`
	InstanceId string `validate:"required,len=14"`
}
