package tencentbundle

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

type fakeCommonSender struct {
	body string
}

func (s fakeCommonSender) Send(_ tchttp.Request, response tchttp.Response) error {
	if common, ok := response.(*tchttp.CommonResponse); ok {
		return common.UnmarshalJSON([]byte(s.body))
	}
	return nil
}

func TestNormalizeSecurityGroupPolicySetIgnoresOrderAndPolicyIndex(t *testing.T) {
	source := map[string]any{
		"Ingress": []any{
			map[string]any{
				"PolicyIndex": 2,
				"Action":      "ACCEPT",
				"CidrBlock":   "10.0.0.0/8",
				"Port":        "ALL",
				"Protocol":    "ALL",
			},
			map[string]any{
				"PolicyIndex": 1,
				"Action":      "ACCEPT",
				"CidrBlock":   "172.16.0.0/16",
				"Port":        "443",
				"Protocol":    "TCP",
			},
		},
	}
	cloned := map[string]any{
		"Ingress": []any{
			map[string]any{
				"PolicyIndex": 8,
				"Action":      "ACCEPT",
				"CidrBlock":   "172.16.0.0/16",
				"Port":        "443",
				"Protocol":    "TCP",
			},
			map[string]any{
				"PolicyIndex": 9,
				"Action":      "ACCEPT",
				"CidrBlock":   "10.0.0.0/8",
				"Port":        "ALL",
				"Protocol":    "ALL",
			},
		},
	}

	gotSource := normalizeSecurityGroupPolicySet(source)
	gotCloned := normalizeSecurityGroupPolicySet(cloned)
	if !reflect.DeepEqual(gotSource, gotCloned) {
		t.Fatalf("expected normalized policy sets to match: source=%v clone=%v", gotSource, gotCloned)
	}
}

func TestDerivedDescriptionIncludesPendingMarker(t *testing.T) {
	got := derivedDescription("k=sg", "st=pending", "src=sg-123", "tc=fi-123")
	meta := parseDerivedDescription(got)
	if meta["k"] != "sg" || meta["st"] != "pending" || meta["src"] != "sg-123" || meta["tc"] != "fi-123" {
		t.Fatalf("unexpected description parse result: %v", meta)
	}
}

func TestParseTencentCreatedTimeAcceptsStandardFormat(t *testing.T) {
	got, ok := parseTencentCreatedTime("2026-04-19 16:00:00")
	if !ok {
		t.Fatalf("expected parse to succeed")
	}
	if got.Year() != 2026 || got.Month() != time.April || got.Day() != 19 {
		t.Fatalf("unexpected parsed time: %v", got)
	}
}

func TestDescribeManagedPendingSecurityGroupShardsFiltersOnlyPendingDerivedGroups(t *testing.T) {
	meta := parseDerivedDescription("k=sg,st=pending,src=sg-src,tc=fi-1")
	if meta["k"] != "sg" || meta["st"] != "pending" {
		t.Fatalf("unexpected parsed meta: %v", meta)
	}
	if ts, ok := parseTencentCreatedTime("2026-04-19 16:00:00"); !ok || ts.IsZero() {
		t.Fatalf("expected CreatedTime to parse, got %v ok=%v", ts, ok)
	}
	sender := fakeCommonSender{body: `{
		"Response": {
			"TotalCount": 3,
			"SecurityGroupSet": [
				{"SecurityGroupId":"sg-pending","SecurityGroupDesc":"k=sg,st=pending,src=sg-src,tc=fi-1","CreatedTime":"2026-04-19 16:00:00","Region":"ap-beijing"},
				{"SecurityGroupId":"sg-active","SecurityGroupDesc":"k=sg,st=active,src=sg-src,tc=fi-1","CreatedTime":"2026-04-19 16:00:00","Region":"ap-beijing"},
				{"SecurityGroupId":"sg-stock","SecurityGroupDesc":"demo-security-group","CreatedTime":"2026-04-19 16:00:00","Region":"ap-beijing"}
			]
		}
	}`}
	resp := tchttp.NewCommonResponse()
	if err := sender.Send(nil, resp); err != nil {
		t.Fatalf("seed fake response: %v", err)
	}
	var payload struct {
		Response struct {
			TotalCount       int `json:"TotalCount"`
			SecurityGroupSet []struct {
				SecurityGroupID   string `json:"SecurityGroupId"`
				SecurityGroupDesc string `json:"SecurityGroupDesc"`
				CreatedTime       string `json:"CreatedTime"`
				Region            string `json:"Region"`
			} `json:"SecurityGroupSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		t.Fatalf("unmarshal fake response body: %v", err)
	}
	if len(payload.Response.SecurityGroupSet) != 3 {
		t.Fatalf("unexpected fake response parse: %+v", payload)
	}
	items, err := DescribeManagedPendingSecurityGroupShards(context.Background(), func(string) CommonSender { return sender }, func(_ context.Context, _ string, fn func() error) error { return fn() }, "ap-beijing")
	if err != nil {
		t.Fatalf("DescribeManagedPendingSecurityGroupShards: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 pending managed sg, got %d (%v)", len(items), items)
	}
	if items[0].ID != "sg-pending" || items[0].State != "pending" || items[0].SourceSecurityGroupID != "sg-src" {
		t.Fatalf("unexpected item: %+v", items[0])
	}
}
