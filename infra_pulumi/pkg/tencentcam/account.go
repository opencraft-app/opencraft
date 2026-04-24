package tencentcam

import (
	"fmt"
	"strconv"

	cam "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cam/v20190116"
	sdkcommon "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkprofile "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

func GetAccountAppID(runtime *config.RuntimeConfig) (string, error) {
	if runtime == nil {
		return "", fmt.Errorf("runtime config is nil")
	}
	if runtime.SecretID == "" || runtime.SecretKey == "" {
		return "", fmt.Errorf("tencent cloud credentials are required to query account app id")
	}

	credential := sdkcommon.NewCredential(runtime.SecretID, runtime.SecretKey)
	client, err := cam.NewClient(credential, "", sdkprofile.NewClientProfile())
	if err != nil {
		return "", fmt.Errorf("create cam client: %w", err)
	}

	response, err := client.GetUserAppId(cam.NewGetUserAppIdRequest())
	if err != nil {
		return "", fmt.Errorf("cam get user app id: %w", err)
	}
	if response == nil || response.Response == nil || response.Response.AppId == nil {
		return "", fmt.Errorf("cam get user app id returned empty app id")
	}
	return strconv.FormatUint(*response.Response.AppId, 10), nil
}
