package tencentbundle

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

type ManagedPendingSecurityGroupShard struct {
	ID                    string
	Region                string
	Description           string
	SourceSecurityGroupID string
	TemplateClassID       string
	State                 string
	CreatedAt             time.Time
}

func CloneSecurityGroup(ctx context.Context, factory ClientFactory, retry RetryFunc, region, sourceSecurityGroupID, templateClassID string) (string, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CloneSecurityGroup")
	req.SetContext(ctx)
	name := fmt.Sprintf("sandbox-%s-%d", shortID(templateClassID), time.Now().Unix())
	if err := req.SetActionParameters(map[string]interface{}{
		"SecurityGroupId": sourceSecurityGroupID,
		"GroupName":       name,
		"GroupDescription": derivedDescription(
			"k=sg",
			"st=pending",
			"src="+strings.TrimSpace(sourceSecurityGroupID),
			"tc="+shortID(templateClassID),
		),
	}); err != nil {
		return "", err
	}

	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.CloneSecurityGroup", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}

	var payload struct {
		Response struct {
			SecurityGroup struct {
				SecurityGroupID string `json:"SecurityGroupId"`
			} `json:"SecurityGroup"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	securityGroupID := strings.TrimSpace(payload.Response.SecurityGroup.SecurityGroupID)
	if securityGroupID == "" {
		return "", fmt.Errorf("CloneSecurityGroup returned empty security group id for source %s", sourceSecurityGroupID)
	}
	return securityGroupID, nil
}

func DescribeManagedPendingSecurityGroupShards(ctx context.Context, factory ClientFactory, retry RetryFunc, region string) ([]ManagedPendingSecurityGroupShard, error) {
	const pageSize = 100
	items := make([]ManagedPendingSecurityGroupShard, 0)
	for offset := 0; ; offset += pageSize {
		req := tchttp.NewCommonRequest(VPCService, VPCVersion, "DescribeSecurityGroups")
		req.SetContext(ctx)
		if err := req.SetActionParameters(map[string]interface{}{
			"Offset": offset,
			"Limit":  pageSize,
		}); err != nil {
			return nil, err
		}

		resp := tchttp.NewCommonResponse()
		if err := retry(ctx, "VPC.DescribeSecurityGroups", func() error {
			return factory(region).Send(req, resp)
		}); err != nil {
			return nil, err
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
			return nil, err
		}
		for _, sg := range payload.Response.SecurityGroupSet {
			meta := parseDerivedDescription(sg.SecurityGroupDesc)
			if meta["k"] != "sg" || meta["st"] != "pending" {
				continue
			}
			createdAt, ok := parseTencentCreatedTime(sg.CreatedTime)
			if !ok {
				continue
			}
			id := strings.TrimSpace(sg.SecurityGroupID)
			if id == "" {
				continue
			}
			items = append(items, ManagedPendingSecurityGroupShard{
				ID:                    id,
				Region:                firstNonEmptyString(strings.TrimSpace(sg.Region), strings.TrimSpace(region)),
				Description:           strings.TrimSpace(sg.SecurityGroupDesc),
				SourceSecurityGroupID: strings.TrimSpace(meta["src"]),
				TemplateClassID:       strings.TrimSpace(meta["tc"]),
				State:                 "pending",
				CreatedAt:             createdAt,
			})
		}
		if len(payload.Response.SecurityGroupSet) < pageSize || len(payload.Response.SecurityGroupSet) == 0 || offset+pageSize >= payload.Response.TotalCount {
			break
		}
	}
	return items, nil
}

func DescribeSecurityGroupPolicies(ctx context.Context, factory ClientFactory, retry RetryFunc, region, securityGroupID string) (map[string]any, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "DescribeSecurityGroupPolicies")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"SecurityGroupId": securityGroupID,
	}); err != nil {
		return nil, err
	}

	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.DescribeSecurityGroupPolicies", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return nil, err
	}

	var payload struct {
		Response struct {
			SecurityGroupPolicySet map[string]any `json:"SecurityGroupPolicySet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, err
	}
	return normalizeSecurityGroupPolicySet(payload.Response.SecurityGroupPolicySet), nil
}

func AssertSecurityGroupPoliciesCloned(ctx context.Context, factory ClientFactory, retry RetryFunc, region, sourceSecurityGroupID, clonedSecurityGroupID string) error {
	sourcePolicies, err := DescribeSecurityGroupPolicies(ctx, factory, retry, region, sourceSecurityGroupID)
	if err != nil {
		return fmt.Errorf("describe source security group policies: %w", err)
	}
	clonedPolicies, err := DescribeSecurityGroupPolicies(ctx, factory, retry, region, clonedSecurityGroupID)
	if err != nil {
		return fmt.Errorf("describe cloned security group policies: %w", err)
	}
	if !reflect.DeepEqual(sourcePolicies, clonedPolicies) {
		sourceJSON, _ := json.Marshal(sourcePolicies)
		clonedJSON, _ := json.Marshal(clonedPolicies)
		diffJSON, _ := json.Marshal(policyDiff(sourcePolicies, clonedPolicies))
		return fmt.Errorf(
			"cloned security group %s policies differ from source %s; diff=%s source=%s cloned=%s",
			clonedSecurityGroupID,
			sourceSecurityGroupID,
			string(diffJSON),
			string(sourceJSON),
			string(clonedJSON),
		)
	}
	return nil
}

func DeleteSecurityGroup(ctx context.Context, factory ClientFactory, retry RetryFunc, region, securityGroupID string) error {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "DeleteSecurityGroup")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"SecurityGroupId": securityGroupID,
	}); err != nil {
		return err
	}

	resp := tchttp.NewCommonResponse()
	return retry(ctx, "VPC.DeleteSecurityGroup", func() error {
		return factory(region).Send(req, resp)
	})
}

func normalizeSecurityGroupPolicySet(raw map[string]any) map[string]any {
	if raw == nil {
		return map[string]any{}
	}
	return map[string]any{
		"Ingress": normalizePolicyRules(raw["Ingress"]),
		"Egress":  normalizePolicyRules(raw["Egress"]),
	}
}

func normalizePolicyRules(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return []map[string]any{}
	}
	rules := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rule, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rules = append(rules, normalizePolicyRule(rule))
	}
	sort.SliceStable(rules, func(i, j int) bool {
		left, _ := json.Marshal(rules[i])
		right, _ := json.Marshal(rules[j])
		return string(left) < string(right)
	})
	return rules
}

func normalizePolicyRule(rule map[string]any) map[string]any {
	return map[string]any{
		"Action":            stringValue(rule["Action"]),
		"CidrBlock":         stringValue(rule["CidrBlock"]),
		"Ipv6CidrBlock":     stringValue(rule["Ipv6CidrBlock"]),
		"Port":              stringValue(rule["Port"]),
		"Protocol":          stringValue(rule["Protocol"]),
		"SecurityGroupId":   stringValue(rule["SecurityGroupId"]),
		"PolicyDescription": stringValue(rule["PolicyDescription"]),
		"AddressTemplate":   normalizePolicyTemplate(rule["AddressTemplate"]),
		"ServiceTemplate":   normalizePolicyTemplate(rule["ServiceTemplate"]),
	}
}

func policyDiff(source, cloned map[string]any) map[string]any {
	different := make([]string, 0)
	for _, key := range []string{"Ingress", "Egress"} {
		if !reflect.DeepEqual(source[key], cloned[key]) {
			different = append(different, key)
		}
	}
	return map[string]any{
		"different_keys": different,
	}
}

func normalizePolicyTemplate(value any) map[string]any {
	raw, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return map[string]any{
		"AddressGroupId": stringValue(raw["AddressGroupId"]),
		"AddressId":      stringValue(raw["AddressId"]),
		"ServiceGroupId": stringValue(raw["ServiceGroupId"]),
		"ServiceId":      stringValue(raw["ServiceId"]),
	}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func derivedDescription(parts ...string) string {
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return strings.Join(items, ",")
}

func parseDerivedDescription(value string) map[string]string {
	items := map[string]string{}
	for _, part := range strings.Split(strings.TrimSpace(value), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, raw, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		raw = strings.TrimSpace(raw)
		if key == "" || raw == "" {
			continue
		}
		items[key] = raw
	}
	return items
}

func parseTencentCreatedTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	layouts := []struct {
		layout string
		loc    *time.Location
	}{
		{layout: "2006-01-02 15:04:05", loc: shanghai},
		{layout: "2006-01-02 15:04:05", loc: time.UTC},
		{layout: time.RFC3339, loc: nil},
	}
	for _, candidate := range layouts {
		var (
			ts  time.Time
			err error
		)
		if candidate.loc != nil {
			ts, err = time.ParseInLocation(candidate.layout, trimmed, candidate.loc)
		} else {
			ts, err = time.Parse(candidate.layout, trimmed)
		}
		if err == nil {
			return ts.UTC(), true
		}
	}
	return time.Time{}, false
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
