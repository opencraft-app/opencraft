package runtimecapacity

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
)

func TestNewTencentTKEOIDCCredentialProviderUsesVPCInternalEndpoint(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("projected-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TKE_REGION", "ap-beijing")
	t.Setenv("TKE_PROVIDER_ID", "cls-test")
	t.Setenv("TKE_WEB_IDENTITY_TOKEN_FILE", tokenFile)
	t.Setenv("TKE_ROLE_ARN", "qcs::cam::uin/100000000001:roleName/test")
	provider, err := NewTencentTKEOIDCCredentialProvider()
	if err != nil {
		t.Fatal(err)
	}
	sdkProvider, ok := provider.provider.(*common.OIDCRoleArnProvider)
	if !ok {
		t.Fatalf("provider type = %T", provider.provider)
	}
	if sdkProvider.Endpoint != tencentSTSInternalEndpoint {
		t.Fatalf("endpoint = %q", sdkProvider.Endpoint)
	}
}

type fakeTencentSDKProvider struct {
	credential common.CredentialIface
	err        error
}

func (p fakeTencentSDKProvider) GetCredential() (common.CredentialIface, error) {
	return p.credential, p.err
}

func TestTencentTKEOIDCCredentialProviderReturnsAtomicTemporaryTuple(t *testing.T) {
	provider := &TencentTKEOIDCCredentialProvider{provider: fakeTencentSDKProvider{
		credential: common.NewTokenCredential("temporary-id", "temporary-key", "temporary-token"),
	}}
	credential, err := provider.GetCredential()
	if err != nil {
		t.Fatal(err)
	}
	if credential != (TencentCredential{
		SecretID: "temporary-id", SecretKey: "temporary-key", Token: "temporary-token",
	}) {
		t.Fatalf("credential = %#v", credential)
	}
}

func TestTencentTKEOIDCCredentialProviderFailsClosed(t *testing.T) {
	for name, provider := range map[string]*TencentTKEOIDCCredentialProvider{
		"missing provider": {},
		"sts error":        {provider: fakeTencentSDKProvider{err: errors.New("denied")}},
		"nil credential":   {provider: fakeTencentSDKProvider{}},
		"incomplete credential": {provider: fakeTencentSDKProvider{
			credential: common.NewTokenCredential("temporary-id", "temporary-key", ""),
		}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := provider.GetCredential(); err == nil {
				t.Fatal("invalid workload identity did not fail closed")
			}
		})
	}
}
