package tencentredis

import (
	"fmt"
	"sort"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkprofile "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	redissdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/redis/v20180412"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

type InstanceSummary struct {
	ID     string
	Name   string
	Status int64
}

func FindInstancesByName(runtime *config.RuntimeConfig, region, name string) ([]InstanceSummary, error) {
	if runtime == nil {
		return nil, fmt.Errorf("runtime config is nil")
	}
	if runtime.SecretID == "" || runtime.SecretKey == "" {
		return nil, fmt.Errorf("tencent cloud credentials are required to query redis instances")
	}
	if region == "" {
		return nil, fmt.Errorf("region is required to query redis instances")
	}
	if name == "" {
		return nil, fmt.Errorf("redis instance name is required")
	}

	client, err := redissdk.NewClient(
		sdkcommon.NewCredential(runtime.SecretID, runtime.SecretKey),
		region,
		sdkprofile.NewClientProfile(),
	)
	if err != nil {
		return nil, fmt.Errorf("create redis client: %w", err)
	}

	request := redissdk.NewDescribeInstancesRequest()
	limit := uint64(100)
	request.Limit = &limit
	request.SearchKey = &name

	response, err := client.DescribeInstances(request)
	if err != nil {
		return nil, fmt.Errorf("redis describe instances: %w", err)
	}
	if response == nil || response.Response == nil || response.Response.InstanceSet == nil {
		return nil, nil
	}

	instances := make([]InstanceSummary, 0, len(response.Response.InstanceSet))
	for _, item := range response.Response.InstanceSet {
		if item == nil || item.InstanceId == nil || item.InstanceName == nil {
			continue
		}
		if *item.InstanceName != name {
			continue
		}
		status := int64(0)
		if item.Status != nil {
			status = *item.Status
		}
		instances = append(instances, InstanceSummary{
			ID:     *item.InstanceId,
			Name:   *item.InstanceName,
			Status: status,
		})
	}

	sort.Slice(instances, func(i, j int) bool {
		if redisStatusRank(instances[i].Status) != redisStatusRank(instances[j].Status) {
			return redisStatusRank(instances[i].Status) < redisStatusRank(instances[j].Status)
		}
		return instances[i].ID < instances[j].ID
	})
	return instances, nil
}

func redisStatusRank(status int64) int {
	switch status {
	case 2:
		return 0
	case 1:
		return 1
	default:
		return 2
	}
}
