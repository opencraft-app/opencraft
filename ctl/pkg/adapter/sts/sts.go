// Package sts ...
package sts

import (
	"ctl/pkg/adapter/tcloud"
)

// AssumeRoleParams ...
type AssumeRoleParams struct {
	RoleArn         string
	RoleSessionName string
	DurationSeconds int64
}

// GetServiceTokenForInternalParams ...
type GetServiceTokenForInternalParams struct {
	TargetProduct   string
	TargetActions   []string
	DurationSeconds int64
}

// GetFederationTokenParams ...
type GetFederationTokenParams struct {
	Name            string
	Policy          string
	DurationSeconds int64
}

// Adapter ...
type Adapter interface {
	AssumeRole(ctx *tcloud.Context, params *AssumeRoleParams) (*tcloud.Credential, error)
	GetServiceTokenForInternal(ctx *tcloud.Context, params *GetServiceTokenForInternalParams) (*tcloud.Credential, error)
	GetFederationToken(ctx *tcloud.Context, params *GetFederationTokenParams) (*tcloud.Credential, error)
}
