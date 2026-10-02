package runtimecapacity

import (
	"fmt"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
)

const tencentSTSInternalEndpoint = "sts.internal.tencentcloudapi.com"

// TencentCredential is one atomic credential tuple. Temporary credentials
// must never be split across refresh boundaries.
type TencentCredential struct {
	SecretID  string
	SecretKey string
	Token     string
}

// TencentCredentialProvider is deliberately narrower than the Tencent SDK.
// A destructive reconcile obtains one complete credential tuple immediately
// before signing its one provider request.
type TencentCredentialProvider interface {
	GetCredential() (TencentCredential, error)
}

type tencentSDKCredentialProvider interface {
	GetCredential() (common.CredentialIface, error)
}

// TencentTKEOIDCCredentialProvider exchanges the projected TKE ServiceAccount
// token for short-lived CAM credentials. It stores no long-lived AK/SK and
// asks STS for a fresh tuple for every rare exact scale-down operation.
type TencentTKEOIDCCredentialProvider struct {
	provider tencentSDKCredentialProvider
}

func NewTencentTKEOIDCCredentialProvider() (*TencentTKEOIDCCredentialProvider, error) {
	provider, err := common.DefaultTkeOIDCRoleArnProvider()
	if err != nil {
		return nil, fmt.Errorf("initialize Tencent TKE OIDC credential provider: %w", err)
	}
	// The runtime control plane has no public Internet route. Tencent Cloud API
	// internal endpoints remain on the VPC network and avoid granting a broad
	// NAT egress capability merely to exchange one workload-identity token.
	provider.Endpoint = tencentSTSInternalEndpoint
	return &TencentTKEOIDCCredentialProvider{provider: provider}, nil
}

func (p *TencentTKEOIDCCredentialProvider) GetCredential() (TencentCredential, error) {
	if p == nil || p.provider == nil {
		return TencentCredential{}, fmt.Errorf("Tencent TKE OIDC credential provider is unavailable")
	}
	credential, err := p.provider.GetCredential()
	if err != nil {
		return TencentCredential{}, fmt.Errorf("assume Tencent TKE OIDC role: %w", err)
	}
	if credential == nil {
		return TencentCredential{}, fmt.Errorf("Tencent TKE OIDC returned no credential")
	}
	secretID, secretKey, token := credential.GetCredential()
	if secretID == "" || secretKey == "" || token == "" {
		return TencentCredential{}, fmt.Errorf("Tencent TKE OIDC returned an incomplete credential")
	}
	return TencentCredential{SecretID: secretID, SecretKey: secretKey, Token: token}, nil
}
