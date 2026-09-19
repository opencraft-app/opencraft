package collaborationbootstrap

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	cynosdb "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cynosdb/v20190107"
	ssm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/ssm/v20190923"
)

const (
	secretVersionID         = "SSM_Current"
	accountReadinessTimeout = 2 * time.Minute
	accountReadinessDelay   = 2 * time.Second
)

type cynosDBClient interface {
	DescribeAccountsWithContext(context.Context, *cynosdb.DescribeAccountsRequest) (*cynosdb.DescribeAccountsResponse, error)
	DescribeClusterDatabasesWithContext(context.Context, *cynosdb.DescribeClusterDatabasesRequest) (*cynosdb.DescribeClusterDatabasesResponse, error)
	DescribeAccountAllGrantPrivilegesWithContext(context.Context, *cynosdb.DescribeAccountAllGrantPrivilegesRequest) (*cynosdb.DescribeAccountAllGrantPrivilegesResponse, error)
	CreateAccountsWithContext(context.Context, *cynosdb.CreateAccountsRequest) (*cynosdb.CreateAccountsResponse, error)
	CreateClusterDatabaseWithContext(context.Context, *cynosdb.CreateClusterDatabaseRequest) (*cynosdb.CreateClusterDatabaseResponse, error)
	ModifyAccountPrivilegesWithContext(context.Context, *cynosdb.ModifyAccountPrivilegesRequest) (*cynosdb.ModifyAccountPrivilegesResponse, error)
	ResetAccountPasswordWithContext(context.Context, *cynosdb.ResetAccountPasswordRequest) (*cynosdb.ResetAccountPasswordResponse, error)
}

type TencentDatabaseAdmin struct {
	client                 cynosDBClient
	accountCreationPending bool
}

func NewTencentDatabaseAdmin(secretID, secretKey, region string) (*TencentDatabaseAdmin, error) {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" || strings.TrimSpace(region) == "" {
		return nil, fmt.Errorf("Tencent Cloud credentials and region are required")
	}
	client, err := cynosdb.NewClient(sdkcommon.NewCredential(secretID, secretKey), region, profile.NewClientProfile())
	if err != nil {
		return nil, err
	}
	return newTencentDatabaseAdmin(client), nil
}

func newTencentDatabaseAdmin(client cynosDBClient) *TencentDatabaseAdmin {
	return &TencentDatabaseAdmin{client: client}
}

func (a *TencentDatabaseAdmin) Inspect(ctx context.Context, config Config) (DatabaseState, error) {
	accountsRequest := cynosdb.NewDescribeAccountsRequest()
	accountsRequest.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	accountsRequest.AccountNames = sdkcommon.StringPtrs([]string{config.Account})
	accountsRequest.Hosts = sdkcommon.StringPtrs([]string{config.AccountHost})
	accountsRequest.Limit = sdkcommon.Int64Ptr(100)
	accountsRequest.Offset = sdkcommon.Int64Ptr(0)
	accountsResponse, err := a.client.DescribeAccountsWithContext(ctx, accountsRequest)
	if err != nil {
		return DatabaseState{}, err
	}
	if accountsResponse == nil || accountsResponse.Response == nil {
		return DatabaseState{}, fmt.Errorf("DescribeAccounts returned an empty response")
	}
	state := DatabaseState{}
	for _, account := range accountsResponse.Response.AccountSet {
		if account != nil && stringValue(account.AccountName) == config.Account && stringValue(account.Host) == config.AccountHost {
			state.AccountExists = true
			break
		}
	}

	offset := int64(0)
	for {
		databaseRequest := cynosdb.NewDescribeClusterDatabasesRequest()
		databaseRequest.ClusterId = sdkcommon.StringPtr(config.ClusterID)
		databaseRequest.Limit = sdkcommon.Int64Ptr(100)
		databaseRequest.Offset = sdkcommon.Int64Ptr(offset)
		databaseResponse, err := a.client.DescribeClusterDatabasesWithContext(ctx, databaseRequest)
		if err != nil {
			return DatabaseState{}, err
		}
		if databaseResponse == nil || databaseResponse.Response == nil {
			return DatabaseState{}, fmt.Errorf("DescribeClusterDatabases returned an empty response")
		}
		for _, database := range databaseResponse.Response.Databases {
			if stringValue(database) == config.Database {
				state.DatabaseExists = true
				break
			}
		}
		if state.DatabaseExists || len(databaseResponse.Response.Databases) == 0 ||
			offset+int64(len(databaseResponse.Response.Databases)) >= int64Value(databaseResponse.Response.TotalCount) {
			break
		}
		offset += int64(len(databaseResponse.Response.Databases))
	}

	if !state.AccountExists || !state.DatabaseExists {
		return state, nil
	}
	privilegeRequest := cynosdb.NewDescribeAccountAllGrantPrivilegesRequest()
	privilegeRequest.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	privilegeRequest.Account = &cynosdb.InputAccount{
		AccountName: sdkcommon.StringPtr(config.Account), Host: sdkcommon.StringPtr(config.AccountHost),
	}
	privilegeResponse, err := a.client.DescribeAccountAllGrantPrivilegesWithContext(ctx, privilegeRequest)
	if err != nil {
		return DatabaseState{}, err
	}
	if privilegeResponse == nil || privilegeResponse.Response == nil {
		return DatabaseState{}, fmt.Errorf("DescribeAccountAllGrantPrivileges returned an empty response")
	}
	state.UnexpectedPrivilegeScope = len(privilegeResponse.Response.GlobalPrivileges) != 0 ||
		len(privilegeResponse.Response.TablePrivileges) != 0
	targetEntries := 0
	for _, entry := range privilegeResponse.Response.DatabasePrivileges {
		if entry == nil || len(entry.Privileges) == 0 {
			continue
		}
		if stringValue(entry.Db) != config.Database {
			state.UnexpectedPrivilegeScope = true
			continue
		}
		targetEntries++
		state.Privileges = append(state.Privileges, sdkcommon.StringValues(entry.Privileges)...)
	}
	if targetEntries > 1 {
		state.UnexpectedPrivilegeScope = true
	}
	return state, nil
}

func (a *TencentDatabaseAdmin) CreateAccount(ctx context.Context, config Config, password string) error {
	description := strings.TrimSpace(config.Description)
	if description == "" {
		description = "LightVela Collaboration runtime"
	}
	request := cynosdb.NewCreateAccountsRequest()
	request.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	request.Accounts = []*cynosdb.NewAccount{{
		AccountName: sdkcommon.StringPtr(config.Account), AccountPassword: sdkcommon.StringPtr(password),
		Host: sdkcommon.StringPtr(config.AccountHost), Description: sdkcommon.StringPtr(description),
		PasswordRotation: sdkcommon.Int64Ptr(0), MaxUserConnections: sdkcommon.Int64Ptr(200),
	}}
	_, err := a.client.CreateAccountsWithContext(ctx, request)
	if err == nil {
		a.accountCreationPending = true
	}
	return err
}

func (a *TencentDatabaseAdmin) ResetAccountPassword(ctx context.Context, config Config, password string) error {
	request := cynosdb.NewResetAccountPasswordRequest()
	request.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	request.AccountName = sdkcommon.StringPtr(config.Account)
	request.Host = sdkcommon.StringPtr(config.AccountHost)
	request.AccountPassword = sdkcommon.StringPtr(password)
	_, err := a.client.ResetAccountPasswordWithContext(ctx, request)
	return err
}

func (a *TencentDatabaseAdmin) CreateDatabase(ctx context.Context, config Config) error {
	description := strings.TrimSpace(config.Description)
	if description == "" {
		description = "LightVela Collaboration authority and projection data"
	}
	request := cynosdb.NewCreateClusterDatabaseRequest()
	request.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	request.DbName = sdkcommon.StringPtr(config.Database)
	request.CharacterSet = sdkcommon.StringPtr("utf8mb4")
	request.CollateRule = sdkcommon.StringPtr("utf8mb4_bin")
	request.Description = sdkcommon.StringPtr(description)
	_, err := a.client.CreateClusterDatabaseWithContext(ctx, request)
	return err
}

func (a *TencentDatabaseAdmin) SetDatabasePrivileges(ctx context.Context, config Config, privileges []string) error {
	request := cynosdb.NewModifyAccountPrivilegesRequest()
	request.ClusterId = sdkcommon.StringPtr(config.ClusterID)
	request.Account = &cynosdb.InputAccount{AccountName: sdkcommon.StringPtr(config.Account), Host: sdkcommon.StringPtr(config.AccountHost)}
	request.GlobalPrivileges = []*string{}
	request.TablePrivileges = []*cynosdb.TablePrivileges{}
	request.DatabasePrivileges = []*cynosdb.DatabasePrivileges{{
		Db: sdkcommon.StringPtr(config.Database), Privileges: sdkcommon.StringPtrs(privileges),
	}}
	readinessCtx, cancel := context.WithTimeout(ctx, accountReadinessTimeout)
	defer cancel()
	for {
		_, err := a.client.ModifyAccountPrivilegesWithContext(readinessCtx, request)
		if err == nil {
			a.accountCreationPending = false
			return nil
		}
		if !a.accountCreationPending || !isAccountNotReady(err) {
			return err
		}
		timer := time.NewTimer(accountReadinessDelay)
		select {
		case <-readinessCtx.Done():
			timer.Stop()
			return fmt.Errorf("collaboration database account did not become ready: %w", errors.Join(err, readinessCtx.Err()))
		case <-timer.C:
		}
	}
}

func isAccountNotReady(err error) bool {
	var sdkErr *tcerr.TencentCloudSDKError
	return errors.As(err, &sdkErr) && sdkErr.Code == "InvalidParameterValue.AccountNotExistError"
}

type ssmClient interface {
	GetSecretValueWithContext(context.Context, *ssm.GetSecretValueRequest) (*ssm.GetSecretValueResponse, error)
	CreateSecretWithContext(context.Context, *ssm.CreateSecretRequest) (*ssm.CreateSecretResponse, error)
	UpdateSecretWithContext(context.Context, *ssm.UpdateSecretRequest) (*ssm.UpdateSecretResponse, error)
}

type TencentSecretStore struct {
	client ssmClient
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

func (s *TencentSecretStore) Read(ctx context.Context, name string) (map[string]string, bool, error) {
	request := ssm.NewGetSecretValueRequest()
	request.SecretName = sdkcommon.StringPtr(name)
	request.VersionId = sdkcommon.StringPtr(secretVersionID)
	response, err := s.client.GetSecretValueWithContext(ctx, request)
	if err != nil {
		if isSecretNotFound(err) {
			return map[string]string{}, false, nil
		}
		return nil, false, err
	}
	if response == nil || response.Response == nil || response.Response.SecretString == nil {
		return nil, false, fmt.Errorf("SSM secret %s has no SecretString", name)
	}
	payload := map[string]string{}
	if err := json.Unmarshal([]byte(*response.Response.SecretString), &payload); err != nil {
		return nil, false, fmt.Errorf("SSM secret %s must be a string-only JSON object: %w", name, err)
	}
	return payload, true, nil
}

func (s *TencentSecretStore) Write(ctx context.Context, name string, payload map[string]string, create bool) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	value := string(encoded)
	if create {
		request := ssm.NewCreateSecretRequest()
		request.SecretName = sdkcommon.StringPtr(name)
		request.VersionId = sdkcommon.StringPtr(secretVersionID)
		request.Description = sdkcommon.StringPtr("LightVela Collaboration runtime secrets")
		request.SecretString = sdkcommon.StringPtr(value)
		_, err = s.client.CreateSecretWithContext(ctx, request)
		return err
	}
	request := ssm.NewUpdateSecretRequest()
	request.SecretName = sdkcommon.StringPtr(name)
	request.VersionId = sdkcommon.StringPtr(secretVersionID)
	request.SecretString = sdkcommon.StringPtr(value)
	_, err = s.client.UpdateSecretWithContext(ctx, request)
	return err
}

func isSecretNotFound(err error) bool {
	var sdkErr *tcerr.TencentCloudSDKError
	return errors.As(err, &sdkErr) &&
		(sdkErr.Code == ssm.RESOURCENOTFOUND || sdkErr.Code == ssm.RESOURCENOTFOUND_SECRETNOTEXIST)
}

type CryptoGenerator struct{}

func (CryptoGenerator) Token(bytes int) (string, error) {
	if bytes <= 0 {
		return "", fmt.Errorf("token byte length must be positive")
	}
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func int64Value(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
