//go:build websiteintegration

package website

import (
	"github.com/tencentyun/cos-go-sdk-v5"
	"net/http"
	"net/url"
)

// NewIntegrationFixture selects only local test transports; it is excluded from
// production builds. The deploy/claim/complete code is the production Deployer.
func NewIntegrationFixture(controlURL, cosURL, runtimeURL, deployToken string) (*Deployer, error) {
	bucket, err := url.Parse(cosURL)
	if err != nil {
		return nil, err
	}
	return &Deployer{ctlBaseURL: controlURL, httpClient: &http.Client{}, maxArtifactBytes: 50 << 20, maxFiles: 200, maxUncompressedBytes: 256 << 20, siteRootDomain: "lightvela.tech", siteURLScheme: "https", runtimeURL: runtimeURL, runtimeToken: deployToken, siteCos: &cosClient{client: cos.NewClient(&cos.BaseURL{BucketURL: bucket}, &http.Client{})}}, nil
}
