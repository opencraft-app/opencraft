package collaborationbootstrap

import (
	"context"
	"reflect"
	"sort"
	"testing"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	cynosdb "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cynosdb/v20190107"
)

type fakeCynosDBClient struct {
	accountResponse   *cynosdb.DescribeAccountsResponse
	databaseResponse  *cynosdb.DescribeClusterDatabasesResponse
	privilegeResponse *cynosdb.DescribeAccountAllGrantPrivilegesResponse
	modifyRequest     *cynosdb.ModifyAccountPrivilegesRequest
}

func (f *fakeCynosDBClient) DescribeAccountsWithContext(context.Context, *cynosdb.DescribeAccountsRequest) (*cynosdb.DescribeAccountsResponse, error) {
	return f.accountResponse, nil
}

func (f *fakeCynosDBClient) DescribeClusterDatabasesWithContext(context.Context, *cynosdb.DescribeClusterDatabasesRequest) (*cynosdb.DescribeClusterDatabasesResponse, error) {
	return f.databaseResponse, nil
}

func (f *fakeCynosDBClient) DescribeAccountAllGrantPrivilegesWithContext(context.Context, *cynosdb.DescribeAccountAllGrantPrivilegesRequest) (*cynosdb.DescribeAccountAllGrantPrivilegesResponse, error) {
	return f.privilegeResponse, nil
}

func (f *fakeCynosDBClient) CreateAccountsWithContext(context.Context, *cynosdb.CreateAccountsRequest) (*cynosdb.CreateAccountsResponse, error) {
	return &cynosdb.CreateAccountsResponse{Response: &cynosdb.CreateAccountsResponseParams{}}, nil
}

func (f *fakeCynosDBClient) CreateClusterDatabaseWithContext(context.Context, *cynosdb.CreateClusterDatabaseRequest) (*cynosdb.CreateClusterDatabaseResponse, error) {
	return &cynosdb.CreateClusterDatabaseResponse{Response: &cynosdb.CreateClusterDatabaseResponseParams{}}, nil
}

func (f *fakeCynosDBClient) ModifyAccountPrivilegesWithContext(_ context.Context, request *cynosdb.ModifyAccountPrivilegesRequest) (*cynosdb.ModifyAccountPrivilegesResponse, error) {
	f.modifyRequest = request
	return &cynosdb.ModifyAccountPrivilegesResponse{Response: &cynosdb.ModifyAccountPrivilegesResponseParams{}}, nil
}

func (f *fakeCynosDBClient) ResetAccountPasswordWithContext(context.Context, *cynosdb.ResetAccountPasswordRequest) (*cynosdb.ResetAccountPasswordResponse, error) {
	return &cynosdb.ResetAccountPasswordResponse{Response: &cynosdb.ResetAccountPasswordResponseParams{}}, nil
}

func TestTencentDatabaseInspectReadsExactTargetState(t *testing.T) {
	client := &fakeCynosDBClient{
		accountResponse: &cynosdb.DescribeAccountsResponse{Response: &cynosdb.DescribeAccountsResponseParams{
			AccountSet: []*cynosdb.Account{{AccountName: sdkcommon.StringPtr("collaboration_rw"), Host: sdkcommon.StringPtr("%")}},
		}},
		databaseResponse: &cynosdb.DescribeClusterDatabasesResponse{Response: &cynosdb.DescribeClusterDatabasesResponseParams{
			Databases: sdkcommon.StringPtrs([]string{"mysql", "lightvela_collaboration"}),
		}},
		privilegeResponse: &cynosdb.DescribeAccountAllGrantPrivilegesResponse{Response: &cynosdb.DescribeAccountAllGrantPrivilegesResponseParams{
			DatabasePrivileges: []*cynosdb.DatabasePrivileges{{
				Db:         sdkcommon.StringPtr("lightvela_collaboration"),
				Privileges: sdkcommon.StringPtrs([]string{"select", "update", "create"}),
			}},
		}},
	}
	state, err := newTencentDatabaseAdmin(client).Inspect(t.Context(), testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !state.AccountExists || !state.DatabaseExists || state.UnexpectedPrivilegeScope || !reflect.DeepEqual(state.Privileges, []string{"select", "update", "create"}) {
		t.Fatalf("state = %+v", state)
	}
}

func TestTencentDatabaseInspectDetectsPrivilegeOutsideTargetDatabase(t *testing.T) {
	client := &fakeCynosDBClient{
		accountResponse: &cynosdb.DescribeAccountsResponse{Response: &cynosdb.DescribeAccountsResponseParams{
			AccountSet: []*cynosdb.Account{{AccountName: sdkcommon.StringPtr("collaboration_rw"), Host: sdkcommon.StringPtr("%")}},
		}},
		databaseResponse: &cynosdb.DescribeClusterDatabasesResponse{Response: &cynosdb.DescribeClusterDatabasesResponseParams{
			Databases: sdkcommon.StringPtrs([]string{"lightvela_collaboration"}),
		}},
		privilegeResponse: &cynosdb.DescribeAccountAllGrantPrivilegesResponse{Response: &cynosdb.DescribeAccountAllGrantPrivilegesResponseParams{
			GlobalPrivileges: sdkcommon.StringPtrs([]string{"CREATE"}),
			DatabasePrivileges: []*cynosdb.DatabasePrivileges{{
				Db: sdkcommon.StringPtr("other_database"), Privileges: sdkcommon.StringPtrs([]string{"SELECT"}),
			}},
		}},
	}
	state, err := newTencentDatabaseAdmin(client).Inspect(t.Context(), testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !state.UnexpectedPrivilegeScope {
		t.Fatalf("unexpected privilege scope was accepted: %+v", state)
	}
}

func TestTencentDatabasePrivilegesAreDatabaseScopedOnly(t *testing.T) {
	client := &fakeCynosDBClient{}
	admin := newTencentDatabaseAdmin(client)
	if err := admin.SetDatabasePrivileges(t.Context(), testConfig(), DatabasePrivileges()); err != nil {
		t.Fatal(err)
	}
	request := client.modifyRequest
	if request == nil || request.Account == nil || request.Account.AccountName == nil || *request.Account.AccountName != "collaboration_rw" {
		t.Fatalf("account request = %#v", request)
	}
	if len(request.GlobalPrivileges) != 0 || len(request.TablePrivileges) != 0 || len(request.DatabasePrivileges) != 1 {
		t.Fatalf("privilege scope widened: %#v", request)
	}
	entry := request.DatabasePrivileges[0]
	if entry.Db == nil || *entry.Db != "lightvela_collaboration" {
		t.Fatalf("database privilege target = %#v", entry)
	}
	got := sdkcommon.StringValues(entry.Privileges)
	want := DatabasePrivileges()
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("privileges = %v, want %v", got, want)
	}
}

func TestCryptoGeneratorReturnsDSNSafeFixedLengthToken(t *testing.T) {
	value, err := (CryptoGenerator{}).Token(32)
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 64 {
		t.Fatalf("token length = %d", len(value))
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			t.Fatalf("token contains unsafe character %q", char)
		}
	}
}
