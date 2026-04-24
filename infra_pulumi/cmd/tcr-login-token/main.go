package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkprofile "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	tcrsdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tcr/v20190924"
)

type loginToken struct {
	RegistryID   string `json:"registry_id"`
	PublicDomain string `json:"public_domain"`
	Username     string `json:"username"`
	Token        string `json:"token"`
}

func main() {
	var (
		region       string
		publicDomain string
		description  string
		tokenType    string
	)

	flag.StringVar(&region, "region", "", "Tencent Cloud region, for example ap-beijing")
	flag.StringVar(&publicDomain, "public-domain", "", "TCR public domain, for example lightclaw-bj8.tencentcloudcr.com")
	flag.StringVar(&description, "description", "codex-registry-login", "Description for the generated TCR token")
	flag.StringVar(&tokenType, "token-type", "longterm", "Token type: longterm or temp")
	flag.Parse()

	if strings.TrimSpace(region) == "" || strings.TrimSpace(publicDomain) == "" {
		fmt.Fprintln(os.Stderr, "usage: tcr-login-token --region <region> --public-domain <domain> [--description <desc>] [--token-type longterm|temp]")
		os.Exit(2)
	}

	secretID := os.Getenv("TENCENTCLOUD_SECRET_ID")
	secretKey := os.Getenv("TENCENTCLOUD_SECRET_KEY")
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" {
		fmt.Fprintln(os.Stderr, "missing TENCENTCLOUD_SECRET_ID or TENCENTCLOUD_SECRET_KEY")
		os.Exit(1)
	}

	client, err := newClient(secretID, secretKey, region)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create tcr client: %v\n", err)
		os.Exit(1)
	}

	registryID, err := findRegistryIDByPublicDomain(client, publicDomain)
	if err != nil {
		fmt.Fprintf(os.Stderr, "resolve registry id: %v\n", err)
		os.Exit(1)
	}

	token, err := createLoginToken(client, registryID, tokenType, description)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create instance token: %v\n", err)
		os.Exit(1)
	}

	token.RegistryID = registryID
	token.PublicDomain = publicDomain
	if err := json.NewEncoder(os.Stdout).Encode(token); err != nil {
		fmt.Fprintf(os.Stderr, "encode token: %v\n", err)
		os.Exit(1)
	}
}

func newClient(secretID, secretKey, region string) (*tcrsdk.Client, error) {
	credential := sdkcommon.NewCredential(secretID, secretKey)
	profile := sdkprofile.NewClientProfile()
	profile.HttpProfile.ReqMethod = "POST"
	profile.HttpProfile.ReqTimeout = 60
	profile.HttpProfile.Endpoint = "tcr.tencentcloudapi.com"
	return tcrsdk.NewClient(credential, region, profile)
}

func findRegistryIDByPublicDomain(client *tcrsdk.Client, publicDomain string) (string, error) {
	request := tcrsdk.NewDescribeInstancesRequest()
	response, err := client.DescribeInstances(request)
	if err != nil {
		return "", err
	}
	for _, registry := range response.Response.Registries {
		if registry == nil || registry.PublicDomain == nil || registry.RegistryId == nil {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(*registry.PublicDomain), strings.TrimSpace(publicDomain)) {
			return *registry.RegistryId, nil
		}
	}
	return "", fmt.Errorf("registry with public domain %q not found", publicDomain)
}

func createLoginToken(client *tcrsdk.Client, registryID, tokenType, description string) (loginToken, error) {
	request := tcrsdk.NewCreateInstanceTokenRequest()
	request.RegistryId = &registryID
	request.TokenType = &tokenType
	request.Desc = &description

	response, err := client.CreateInstanceToken(request)
	if err != nil {
		return loginToken{}, err
	}
	if response.Response == nil || response.Response.Username == nil || response.Response.Token == nil {
		return loginToken{}, fmt.Errorf("tcr token response missing username/token")
	}
	return loginToken{
		Username: *response.Response.Username,
		Token:    *response.Response.Token,
	}, nil
}
