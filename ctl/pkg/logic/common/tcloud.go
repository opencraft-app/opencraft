// Package common ...
package common

import (
	"ctl/pkg/adapter/tcloud"
	"ctl/pkg/context"
)

// TcloudContextForApiV3 ...
func TcloudContextForApiV3(ctx context.Context) *tcloud.Context {
	return &tcloud.Context{
		Ctx:    ctx,
		Region: ctx.GetRegion(),
		Account: &tcloud.Account{
			UserID:      ctx.GetUserID(),
			Credentials: nil,
		},
		Headers:          nil,
		ExtRequestParams: nil,
	}
}

// TcloudContextForTcloud ...
func TcloudContextForTcloud(ctx context.Context, credential *tcloud.Credential) *tcloud.Context {
	return &tcloud.Context{
		Ctx:    ctx,
		Region: ctx.GetRegion(),
		Account: &tcloud.Account{
			Credentials: &tcloud.Credential{
				SecretId:  credential.SecretId,
				SecretKey: credential.SecretKey,
				Token:     credential.Token,
			},
		},
		Headers:          nil,
		ExtRequestParams: nil,
	}
}
