package app

import (
	"flag"
	"testing"
	"time"

	"ctl/pkg/logic/app"
	"ctl/pkg/util"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

func TestInitAppCacheData(t *testing.T) {
	for i := 0; i < 3; i++ {
		t.Log(app.LatestCacheTime())
		time.Sleep(time.Second * 4)
	}
}

func TestListAllApps(t *testing.T) {
	l := app.NewLogic()

	for i, item := range l.ListAllApps(test.Context()) {
		t.Log(i, item)
	}
}

func TestAppByName(t *testing.T) {
	l := app.NewLogic()
	ctx := test.Context()

	for i, item := range l.ListAllApps(test.Context()) {
		item = l.AppByName(ctx, item.Name)
		t.Log(i, item)
	}
}

func TestAppBySecretId(t *testing.T) {
	l := app.NewLogic()
	ctx := test.Context()

	for i, item := range l.ListAllApps(test.Context()) {
		item = l.AppBySecretId(ctx, item.SecretId)
		t.Log(i, item)
	}
}

// TestGenerateCredential: go test -v -test.run=TestGenerateCredential -args app-name
func TestGenerateCredential(t *testing.T) {
	if !flag.Parsed() {
		flag.Parse()
	}

	argList := flag.Args()
	if len(argList) == 0 {
		t.Skip("manual utility test: provide app-name to run")
	}

	appName := argList[0]
	l := app.NewLogic()
	credential := l.GenerateCredential(test.Context(), appName)

	t.Log("AppName", appName)
	t.Log("SecretId", credential.SecretId, util.EncryptString(credential.SecretId))
	t.Log("SecretKey", credential.SecretKey, util.EncryptString(credential.SecretKey))
}
