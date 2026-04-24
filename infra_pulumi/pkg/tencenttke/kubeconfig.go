package tencenttke

import (
	"fmt"

	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkprofile "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	tke "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tke/v20180525"
)

func GetClusterKubeconfig(secretID, secretKey, region, clusterID string, isExtranet bool) (string, error) {
	if secretID == "" || secretKey == "" {
		return "", fmt.Errorf("tencent cloud credentials are required to query cluster kubeconfig")
	}
	if region == "" {
		return "", fmt.Errorf("region is required to query cluster kubeconfig")
	}
	if clusterID == "" {
		return "", fmt.Errorf("cluster id is required to query cluster kubeconfig")
	}

	credential := sdkcommon.NewCredential(secretID, secretKey)
	client, err := tke.NewClient(credential, region, sdkprofile.NewClientProfile())
	if err != nil {
		return "", fmt.Errorf("create tke client: %w", err)
	}

	request := tke.NewDescribeClusterKubeconfigRequest()
	request.ClusterId = &clusterID
	request.IsExtranet = &isExtranet

	response, err := client.DescribeClusterKubeconfig(request)
	if err != nil {
		return "", fmt.Errorf("tke describe cluster kubeconfig: %w", err)
	}
	if response == nil || response.Response == nil || response.Response.Kubeconfig == nil {
		return "", fmt.Errorf("tke describe cluster kubeconfig returned empty kubeconfig")
	}

	return *response.Response.Kubeconfig, nil
}

type ClusterEndpoints struct {
	ExternalEndpoint string
	IntranetEndpoint string
	IntranetSubnetID string
}

func GetClusterEndpoints(secretID, secretKey, region, clusterID string) (*ClusterEndpoints, error) {
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("tencent cloud credentials are required to query cluster endpoints")
	}
	if region == "" {
		return nil, fmt.Errorf("region is required to query cluster endpoints")
	}
	if clusterID == "" {
		return nil, fmt.Errorf("cluster id is required to query cluster endpoints")
	}

	credential := sdkcommon.NewCredential(secretID, secretKey)
	client, err := tke.NewClient(credential, region, sdkprofile.NewClientProfile())
	if err != nil {
		return nil, fmt.Errorf("create tke client: %w", err)
	}

	request := tke.NewDescribeClusterEndpointsRequest()
	request.ClusterId = &clusterID

	response, err := client.DescribeClusterEndpoints(request)
	if err != nil {
		return nil, fmt.Errorf("tke describe cluster endpoints: %w", err)
	}
	if response == nil || response.Response == nil {
		return nil, fmt.Errorf("tke describe cluster endpoints returned empty response")
	}

	result := &ClusterEndpoints{}
	if response.Response.ClusterExternalEndpoint != nil {
		result.ExternalEndpoint = *response.Response.ClusterExternalEndpoint
	}
	if response.Response.ClusterIntranetEndpoint != nil {
		result.IntranetEndpoint = *response.Response.ClusterIntranetEndpoint
	}
	if response.Response.ClusterIntranetSubnetId != nil {
		result.IntranetSubnetID = *response.Response.ClusterIntranetSubnetId
	}
	return result, nil
}
