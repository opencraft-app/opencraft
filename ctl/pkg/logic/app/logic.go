// Package app ...
package app

import (
	"fmt"
	"math/rand"
	"strings"
	"time"

	"ctl/pkg/context"
	"ctl/pkg/util"
)

// Credential ...
type Credential struct {
	SecretId  string
	SecretKey string
}

// Logic ...
type Logic interface {
	ListAllApps(ctx context.Context) []*App
	AppByName(ctx context.Context, appName string) *App
	AppBySecretId(ctx context.Context, secretId string) *App
	GenerateCredential(ctx context.Context, appName string) *Credential
}

type logic struct {
}

// NewLogic ...
func NewLogic() *logic {
	return &logic{}
}

// ListAllApps ...
func (l *logic) ListAllApps(ctx context.Context) []*App {
	var result []*App
	for _, app := range appsCacheData.appMapByName {
		result = append(result, app)
	}

	return result
}

// AppByName ...
func (l *logic) AppByName(ctx context.Context, appName string) *App {
	return appsCacheData.appMapByName[appName]
}

// AppBySecretId ...
func (l *logic) AppBySecretId(ctx context.Context, secretId string) *App {
	return appsCacheData.appMapBySecretId[secretId]
}

// GenerateCredential ...
func (l *logic) GenerateCredential(ctx context.Context, appName string) *Credential {
	ts := time.Now().Unix()
	secretId := fmt.Sprintf("lightglobal-app-%s-t-%d-secretid", appName, ts)
	secretKey := fmt.Sprintf("lightglobal-app-%s-t-%d-secretkey", appName, ts)

	return &Credential{
		SecretId:  l.generateSecret(secretId),
		SecretKey: l.generateSecret(secretKey),
	}
}

func (l *logic) generateSecret(secret string) string {
	secret = util.Sha256(secret)
	var result string

	for i := 0; i < len(secret); i++ {
		s := string(secret[i])
		n := rand.Intn(100)
		if n%2 == 1 {
			s = strings.ToUpper(s)
		}
		result += s
	}

	return result
}
