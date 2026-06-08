package rescue

import (
	"errors"
	"strings"

	"go.temporal.io/sdk/temporal"
)

const nonRetryableConfigErrorType = "RescueExporterConfigError"

func temporalActivityError(err error) error {
	if err == nil {
		return nil
	}
	if isNonRetryableActivityError(err) {
		return temporal.NewNonRetryableApplicationError(err.Error(), nonRetryableConfigErrorType, err)
	}
	return err
}

func isNonRetryableActivityError(err error) bool {
	var apiErr *TencentAPIError
	if errors.As(err, &apiErr) {
		return isNonRetryableTencentCode(apiErr.Code)
	}
	lower := strings.ToLower(err.Error())
	for _, marker := range []string{
		"missing tencent credentials",
		"rescue password env",
		"no ssh host available",
		"missing --cos-upload-bucket-url",
		"invalid cos bucket url",
		"tat uploader script is too large",
		"returned no invocationid",
		"unknown tat archive mode",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func isNonRetryableTencentCode(code string) bool {
	if code == "" {
		return false
	}
	for _, prefix := range []string{
		"AuthFailure",
		"UnauthorizedOperation",
		"InvalidParameter",
		"InvalidParameterValue",
		"InvalidAction",
		"MissingParameter",
	} {
		if strings.HasPrefix(code, prefix) {
			return true
		}
	}
	return false
}
