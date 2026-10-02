package main

import (
	"errors"
	"testing"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity"
)

type selfCheckCredentialProvider struct {
	err error
}

func (p selfCheckCredentialProvider) GetCredential() (runtimecapacity.TencentCredential, error) {
	if p.err != nil {
		return runtimecapacity.TencentCredential{}, p.err
	}
	return runtimecapacity.TencentCredential{SecretID: "temporary", SecretKey: "temporary", Token: "temporary"}, nil
}

func TestRunOIDCCredentialSelfCheck(t *testing.T) {
	called := false
	run, err := runOIDCCredentialSelfCheck([]string{"--oidc-credential-self-check"}, func() (runtimecapacity.TencentCredentialProvider, error) {
		called = true
		return selfCheckCredentialProvider{}, nil
	})
	if err != nil || !run || !called {
		t.Fatalf("self-check did not run successfully: run=%v called=%v err=%v", run, called, err)
	}
}

func TestHelpDoesNotRequireRuntimeEnvironment(t *testing.T) {
	for _, argument := range []string{"--help", "-h"} {
		if !helpRequested([]string{argument}) {
			t.Fatalf("%s did not select the side-effect-free help path", argument)
		}
	}
	if helpRequested(nil) || helpRequested([]string{"--delete-machine"}) ||
		helpRequested([]string{"--help", "extra"}) {
		t.Fatal("non-help invocation selected the help path")
	}
}

func TestRunOIDCCredentialSelfCheckRejectsUnknownArguments(t *testing.T) {
	run, err := runOIDCCredentialSelfCheck([]string{"--delete-machine"}, func() (runtimecapacity.TencentCredentialProvider, error) {
		t.Fatal("provider must not be created for an unknown argument")
		return nil, nil
	})
	if run || err == nil {
		t.Fatalf("unknown argument was accepted: run=%v err=%v", run, err)
	}
}

func TestRunOIDCCredentialSelfCheckFailsClosed(t *testing.T) {
	want := errors.New("STS unavailable")
	run, err := runOIDCCredentialSelfCheck([]string{"--oidc-credential-self-check"}, func() (runtimecapacity.TencentCredentialProvider, error) {
		return selfCheckCredentialProvider{err: want}, nil
	})
	if !run || !errors.Is(err, want) {
		t.Fatalf("provider failure was not preserved: run=%v err=%v", run, err)
	}
}
