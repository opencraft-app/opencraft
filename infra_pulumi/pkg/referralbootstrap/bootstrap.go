package referralbootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	ssm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/ssm/v20190923"
	tdmq "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tdmq/v20200217"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

const (
	secretVersionID = "SSM_Current"
	tokenKey        = "REFERRAL_PULSAR_TOKEN"
)

type RoleReader interface {
	TokenForRole(context.Context, string, string) (string, error)
}

type SecretStore interface {
	Read(context.Context, string) (map[string]any, bool, error)
	Write(context.Context, string, map[string]any, bool) error
}

type Options struct {
	Apply            bool
	AllowTokenChange bool
}

type Result struct {
	RoleName   string
	SecretName string
	Created    bool
	Updated    bool
	Applied    bool
}

type binding struct {
	roleName       string
	secretName     string
	createIfAbsent bool
}

func Run(ctx context.Context, inventory *config.Inventory, roles RoleReader, secrets SecretStore, options Options) ([]Result, error) {
	if inventory == nil || roles == nil || secrets == nil {
		return nil, fmt.Errorf("referral token bootstrap dependencies are incomplete")
	}
	pulsar := inventory.Stacks.Pulsar
	if !pulsar.Enabled {
		return nil, fmt.Errorf("stack %s does not enable referral Pulsar", inventory.EnvName)
	}
	bindings := []binding{
		{roleName: pulsar.UserAuthProducerRole, secretName: pulsar.UserAuthSSMSecret},
		{roleName: pulsar.CTLProducerRole, secretName: pulsar.CTLSSMSecret},
		{roleName: pulsar.ReferralConsumerRole, secretName: pulsar.ReferralSSMSecret, createIfAbsent: true},
	}

	tokens := make([]string, len(bindings))
	payloads := make([]map[string]any, len(bindings))
	exists := make([]bool, len(bindings))
	for index, item := range bindings {
		token, err := roles.TokenForRole(ctx, pulsar.ExistingClusterID, item.roleName)
		if err != nil {
			return nil, fmt.Errorf("read token for role %s: %w", item.roleName, err)
		}
		if strings.TrimSpace(token) == "" {
			return nil, fmt.Errorf("role %s returned an empty token", item.roleName)
		}
		tokens[index] = token

		payload, found, err := secrets.Read(ctx, item.secretName)
		if err != nil {
			return nil, fmt.Errorf("read SSM secret %s: %w", item.secretName, err)
		}
		if !found && !item.createIfAbsent {
			return nil, fmt.Errorf("required SSM secret %s does not exist", item.secretName)
		}
		if payload == nil {
			payload = map[string]any{}
		}
		if rawCurrent, ok := payload[tokenKey]; ok {
			current, isString := rawCurrent.(string)
			if !isString {
				return nil, fmt.Errorf("SSM secret %s contains a non-string %s", item.secretName, tokenKey)
			}
			if strings.TrimSpace(current) != "" && current != token && !options.AllowTokenChange {
				return nil, fmt.Errorf("SSM secret %s already contains a different %s; rerun with --allow-token-change to rotate", item.secretName, tokenKey)
			}
		}
		payloads[index] = payload
		exists[index] = found
	}
	seenTokens := make(map[string]string, len(tokens))
	for index, token := range tokens {
		if previousRole, ok := seenTokens[token]; ok {
			return nil, fmt.Errorf("roles %s and %s unexpectedly share one token", previousRole, bindings[index].roleName)
		}
		seenTokens[token] = bindings[index].roleName
	}

	results := make([]Result, 0, len(bindings))
	for index, item := range bindings {
		current, _ := payloads[index][tokenKey].(string)
		result := Result{RoleName: item.roleName, SecretName: item.secretName, Created: !exists[index]}
		if current != tokens[index] || !exists[index] {
			payloads[index][tokenKey] = tokens[index]
			if options.Apply {
				if err := secrets.Write(ctx, item.secretName, payloads[index], !exists[index]); err != nil {
					return results, fmt.Errorf("write SSM secret %s: %w", item.secretName, err)
				}
				result.Applied = true
			}
			result.Updated = true
		}
		results = append(results, result)
	}
	return results, nil
}

type TencentRoleReader struct {
	client *tdmq.Client
}

func NewTencentRoleReader(secretID, secretKey, region string) (*TencentRoleReader, error) {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" || strings.TrimSpace(region) == "" {
		return nil, fmt.Errorf("Tencent Cloud credentials and region are required")
	}
	client, err := tdmq.NewClient(sdkcommon.NewCredential(secretID, secretKey), region, profile.NewClientProfile())
	if err != nil {
		return nil, err
	}
	return &TencentRoleReader{client: client}, nil
}

func (r *TencentRoleReader) TokenForRole(ctx context.Context, clusterID, roleName string) (string, error) {
	request := tdmq.NewDescribeRolesRequest()
	request.ClusterId = sdkcommon.StringPtr(clusterID)
	request.Filters = []*tdmq.Filter{{Name: sdkcommon.StringPtr("RoleName"), Values: sdkcommon.StringPtrs([]string{roleName})}}
	request.Limit = sdkcommon.Int64Ptr(20)
	response, err := r.client.DescribeRolesWithContext(ctx, request)
	if err != nil {
		return "", err
	}
	if response == nil || response.Response == nil {
		return "", fmt.Errorf("DescribeRoles returned an empty response")
	}
	matches := make([]*tdmq.Role, 0, 1)
	for _, role := range response.Response.RoleSets {
		if role != nil && role.RoleName != nil && *role.RoleName == roleName {
			matches = append(matches, role)
		}
	}
	if len(matches) != 1 || matches[0].Token == nil || strings.TrimSpace(*matches[0].Token) == "" {
		return "", fmt.Errorf("expected exactly one role with a non-empty token, got %d", len(matches))
	}
	return strings.TrimSpace(*matches[0].Token), nil
}

type TencentSecretStore struct {
	client *ssm.Client
}

func NewTencentSecretStore(secretID, secretKey, region string) (*TencentSecretStore, error) {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" || strings.TrimSpace(region) == "" {
		return nil, fmt.Errorf("Tencent Cloud credentials and region are required")
	}
	client, err := ssm.NewClient(sdkcommon.NewCredential(secretID, secretKey), region, profile.NewClientProfile())
	if err != nil {
		return nil, err
	}
	return &TencentSecretStore{client: client}, nil
}

func (s *TencentSecretStore) Read(ctx context.Context, secretName string) (map[string]any, bool, error) {
	request := ssm.NewGetSecretValueRequest()
	request.SecretName = sdkcommon.StringPtr(secretName)
	request.VersionId = sdkcommon.StringPtr(secretVersionID)
	response, err := s.client.GetSecretValueWithContext(ctx, request)
	if err != nil {
		if isSecretNotFoundError(err) {
			return map[string]any{}, false, nil
		}
		return nil, false, err
	}
	if response == nil || response.Response == nil || response.Response.SecretString == nil {
		return nil, false, fmt.Errorf("SSM secret %s has no SecretString", secretName)
	}
	payload := map[string]any{}
	decoder := json.NewDecoder(strings.NewReader(*response.Response.SecretString))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return nil, false, fmt.Errorf("SSM secret %s is not a JSON object: %w", secretName, err)
	}
	return payload, true, nil
}

func isSecretNotFoundError(err error) bool {
	var sdkErr *tcerr.TencentCloudSDKError
	return errors.As(err, &sdkErr) &&
		(sdkErr.Code == ssm.RESOURCENOTFOUND || sdkErr.Code == ssm.RESOURCENOTFOUND_SECRETNOTEXIST)
}

func (s *TencentSecretStore) Write(ctx context.Context, secretName string, payload map[string]any, create bool) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	value := string(encoded)
	if create {
		request := ssm.NewCreateSecretRequest()
		request.SecretName = sdkcommon.StringPtr(secretName)
		request.VersionId = sdkcommon.StringPtr(secretVersionID)
		request.Description = sdkcommon.StringPtr("LightVela referral runtime secrets")
		request.SecretString = sdkcommon.StringPtr(value)
		_, err = s.client.CreateSecretWithContext(ctx, request)
		return err
	}
	request := ssm.NewUpdateSecretRequest()
	request.SecretName = sdkcommon.StringPtr(secretName)
	request.VersionId = sdkcommon.StringPtr(secretVersionID)
	request.SecretString = sdkcommon.StringPtr(value)
	_, err = s.client.UpdateSecretWithContext(ctx, request)
	return err
}
