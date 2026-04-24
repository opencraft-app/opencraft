package tencenttcr

import (
	"context"
	"fmt"
	"strings"
	"time"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkprofile "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	tcrsdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tcr/v20190924"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

type InstanceSummary struct {
	RegistryID   string
	Name         string
	Status       string
	PublicDomain string
}

func FindInstanceByName(ctx context.Context, runtime *config.RuntimeConfig, region string, name string) (*InstanceSummary, error) {
	client, err := newClient(runtime, region)
	if err != nil {
		return nil, err
	}

	request := tcrsdk.NewDescribeInstancesRequest()
	response, err := client.DescribeInstances(request)
	if err != nil {
		return nil, err
	}

	for _, registry := range response.Response.Registries {
		if registry == nil || registry.RegistryName == nil || *registry.RegistryName != name {
			continue
		}
		summary := &InstanceSummary{
			Name:         name,
			Status:       valueOrEmpty(registry.Status),
			PublicDomain: valueOrEmpty(registry.PublicDomain),
		}
		if registry.RegistryId != nil {
			summary.RegistryID = *registry.RegistryId
		}
		return summary, nil
	}
	return nil, nil
}

func WaitUntilReady(ctx context.Context, runtime *config.RuntimeConfig, region string, name string, timeout time.Duration, interval time.Duration) (*InstanceSummary, error) {
	deadline := time.Now().Add(timeout)
	for {
		summary, err := FindInstanceByName(ctx, runtime, region, name)
		if err != nil {
			return nil, err
		}
		if summary == nil {
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("tcr instance %q was not found before timeout", name)
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(interval):
				continue
			}
		}

		status := strings.TrimSpace(strings.ToLower(summary.Status))
		switch status {
		case "running":
			return summary, nil
		case "failedcreated":
			return nil, fmt.Errorf("tcr instance %q (%s) entered FailedCreated", name, summary.RegistryID)
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("tcr instance %q (%s) did not become ready before timeout; last status=%q", name, summary.RegistryID, summary.Status)
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

func newClient(runtime *config.RuntimeConfig, region string) (*tcrsdk.Client, error) {
	credential := sdkcommon.NewCredential(
		runtime.SecretID,
		runtime.SecretKey,
	)
	profile := sdkprofile.NewClientProfile()
	profile.HttpProfile.ReqMethod = "POST"
	profile.HttpProfile.ReqTimeout = 60
	profile.HttpProfile.Endpoint = "tcr.tencentcloudapi.com"
	return tcrsdk.NewClient(credential, region, profile)
}

func valueOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
