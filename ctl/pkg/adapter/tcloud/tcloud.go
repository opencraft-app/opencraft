// Package tcloud ...
package tcloud

import (
	"ctl/pkg/context"
)

// Credential ...
type Credential struct {
	SecretId  string
	SecretKey string
	Token     string
}

// Account ...
type Account struct {
	UserID      string
	Credentials *Credential
}

// Context ...
type Context struct {
	Ctx              context.Context
	Region           string
	Account          *Account
	Headers          map[string]string
	ExtRequestParams map[string]interface{}
}

// TcloudError ...
type TcloudError struct {
	Code    string
	Message string
}

// Error ...
func (e *TcloudError) Error() string {
	return e.Message
}

// HasTcloudErrorCode ...
func HasTcloudErrorCode(err error, code string) bool {
	if err == nil {
		return false
	}
	terr := ExtractTcloudError(err)
	if terr == nil {
		return false
	}
	return terr.Code == code
}

// ExtractTcloudError ...
func ExtractTcloudError(err error) *TcloudError {
	if err == nil {
		return nil
	}
	if terr, ok := err.(*TcloudError); ok {
		return terr
	}
	return nil
}

// AuthorizationV3 ...
func AuthorizationV3(secretId, secretKey, host, service, body string, t int64) string {
	return ""
}
