package provider

import (
	"strings"

	tcerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
)

// ClassifyCreateError returns the cloud error code when available and whether the
// error is considered terminal for automated refill retries.
func ClassifyCreateError(err error) (code string, terminal bool) {
	if err == nil {
		return "", false
	}
	if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok {
		code = strings.TrimSpace(sdk.Code)
	} else {
		code = extractTencentErrorCode(err.Error())
	}
	if code == "" {
		return "", false
	}
	if code == rateLimitCode {
		return code, false
	}
	if strings.HasPrefix(code, "InvalidZone.") {
		return code, true
	}
	switch code {
	case "InvalidParameterValue.VpcIdZoneIdNotMatch",
		"FailedOperation.NoAvailableIpAddressCountInSubnet",
		"FailedOperation.SecurityGroupActionFailed",
		"InstancesQuotaLimitExceeded",
		"LimitExceeded.CvmInstanceQuota",
		"LimitExceeded.InstanceQuota",
		"LimitExceeded.PrepayQuota",
		"LimitExceeded.CvmsVifsPerSecGroupLimitExceeded",
		"LimitExceeded.SingleUSGQuota",
		"LimitExceeded.VpcSubnetNum",
		"ResourceInsufficient.AvailabilityZoneSoldOut",
		"ResourceInsufficient.SpecifiedInstanceType",
		"ResourcesSoldOut.SpecifiedInstanceType",
		"ResourceUnavailable.InstanceType":
		return code, true
	}
	if strings.Contains(code, "InstanceType") {
		return code, true
	}
	if strings.HasPrefix(code, "UnsupportedOperation.") {
		if strings.Contains(code, "Zone") || strings.Contains(code, "InstanceType") {
			return code, true
		}
	}
	return code, false
}

func extractTencentErrorCode(msg string) string {
	marker := "code:"
	idx := strings.Index(msg, marker)
	if idx < 0 {
		return ""
	}
	rest := strings.TrimSpace(msg[idx+len(marker):])
	if rest == "" {
		return ""
	}
	for i, r := range rest {
		switch r {
		case ' ', '\t', '\n', '\r':
			return strings.TrimSpace(rest[:i])
		}
	}
	return strings.TrimSpace(rest)
}
