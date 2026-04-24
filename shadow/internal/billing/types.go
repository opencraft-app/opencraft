package billing

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

const (
	ModeCreateInstance = "create-instance"
	ModeRenewInstance  = "renew-instance"
	ModeModifyInstance = "modify-instance"
	ModeTrafficPackage = "traffic-package"
	ModeConsole        = "console"
)

type FreeTrialOrderInput struct {
	UserID         string
	ShadowUserName string
	CountryCode    string
	PhoneNumber    string
	Uin            int64
	OwnerUin       int64
	AppID          int64
	SaaSToken      string
	ClientIP       string
	ClientUA       string
}

type FreeTrialOrderResult struct {
	BigDealID  string
	DealName   string
	InstanceID string
}

type Provider interface {
	CreateFreeTrialOrderAndPay(ctx context.Context, in FreeTrialOrderInput) (FreeTrialOrderResult, error)
}

var (
	ErrDuplicateOrder  = errors.New("duplicate free-trial order")
	ErrDeliveryDelayed = errors.New("free-trial delivery delayed")
)

func BuildTargetURL(mode, instanceID, consolePath string) (string, error) {
	switch mode {
	case ModeCreateInstance:
		return "https://buy.cloud.tencent.com/tced", nil
	case ModeRenewInstance:
		if instanceID == "" {
			return "", errors.New("instance_id is required for renew-instance")
		}
		return fmt.Sprintf("https://buy.cloud.tencent.com/tced_update?action=renew&instanceId=%s", url.QueryEscape(instanceID)), nil
	case ModeModifyInstance:
		if instanceID == "" {
			return "", errors.New("instance_id is required for modify-instance")
		}
		return fmt.Sprintf("https://buy.cloud.tencent.com/tced_update?action=modify&instanceId=%s", url.QueryEscape(instanceID)), nil
	case ModeTrafficPackage:
		if instanceID == "" {
			return "", errors.New("instance_id is required for traffic-package")
		}
		return fmt.Sprintf("https://buy.cloud.tencent.com/tced_package?instanceId=%s", url.QueryEscape(instanceID)), nil
	case ModeConsole:
		if consolePath == "" {
			return "", errors.New("console is required for console mode")
		}
		return fmt.Sprintf("https://console.cloud.tencent.com/%s", strings.TrimLeft(consolePath, "/")), nil
	default:
		return "", fmt.Errorf("unsupported mode %q", mode)
	}
}

func BuildJumpLoginURL(platform, authCode, userAgent, targetURL string) string {
	v := url.Values{}
	v.Set("code", authCode)
	v.Set("platform", platform)
	v.Set("clientUA", userAgent)
	v.Set("s_url", targetURL)
	return "https://cloud.tencent.com/login/saas/jumpLoginByCode?" + v.Encode()
}
