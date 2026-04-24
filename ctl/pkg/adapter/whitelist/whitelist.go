// Package whitelist ...
package whitelist

import (
	"ctl/pkg/context"
)

// QConfigBatchGetWhiteListData ...
type QConfigBatchGetWhiteListData map[string][]string

// Context ...
type Context struct {
	Context context.Context
}

// Adapter ...
type Adapter interface {
	QConfigBatchGetWhiteList(ctx *Context, typeList []string, whiteListItems []string) (QConfigBatchGetWhiteListData, error)
}
