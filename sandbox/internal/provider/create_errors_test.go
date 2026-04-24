package provider

import (
	"errors"
	"testing"
)

func TestClassifyCreateErrorTencentDocumentedScenarios(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		err          error
		wantCode     string
		wantTerminal bool
	}{
		{
			name:         "security group eni limit exceeded",
			err:          errors.New("[TencentCloudSDKException] code:LimitExceeded.CvmsVifsPerSecGroupLimitExceeded message:security group eni limit exceeded"),
			wantCode:     "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded",
			wantTerminal: true,
		},
		{
			name:         "single security group quota exceeded",
			err:          errors.New("[TencentCloudSDKException] code:LimitExceeded.SingleUSGQuota message:single security group quota exceeded"),
			wantCode:     "LimitExceeded.SingleUSGQuota",
			wantTerminal: true,
		},
		{
			name:         "subnet no available ip",
			err:          errors.New("[TencentCloudSDKException] code:FailedOperation.NoAvailableIpAddressCountInSubnet message:no available ip address"),
			wantCode:     "FailedOperation.NoAvailableIpAddressCountInSubnet",
			wantTerminal: true,
		},
		{
			name:         "vpc subnet quota exceeded",
			err:          errors.New("[TencentCloudSDKException] code:LimitExceeded.VpcSubnetNum message:vpc subnet num exceeded"),
			wantCode:     "LimitExceeded.VpcSubnetNum",
			wantTerminal: true,
		},
		{
			name:         "instance quota exceeded",
			err:          errors.New("[TencentCloudSDKException] code:InstancesQuotaLimitExceeded message:instance quota exceeded"),
			wantCode:     "InstancesQuotaLimitExceeded",
			wantTerminal: true,
		},
		{
			name:         "availability zone sold out",
			err:          errors.New("[TencentCloudSDKException] code:ResourceInsufficient.AvailabilityZoneSoldOut message:availability zone sold out"),
			wantCode:     "ResourceInsufficient.AvailabilityZoneSoldOut",
			wantTerminal: true,
		},
		{
			name:         "instance type sold out",
			err:          errors.New("[TencentCloudSDKException] code:ResourcesSoldOut.SpecifiedInstanceType message:specified instance type sold out"),
			wantCode:     "ResourcesSoldOut.SpecifiedInstanceType",
			wantTerminal: true,
		},
		{
			name:         "zone vpc mismatch",
			err:          errors.New("[TencentCloudSDKException] code:InvalidParameterValue.VpcIdZoneIdNotMatch message:vpc id and zone id do not match"),
			wantCode:     "InvalidParameterValue.VpcIdZoneIdNotMatch",
			wantTerminal: true,
		},
		{
			name:         "request limit exceeded remains retryable",
			err:          errors.New("[TencentCloudSDKException] code:RequestLimitExceeded message:rate limited"),
			wantCode:     "RequestLimitExceeded",
			wantTerminal: false,
		},
		{
			name:         "generic error remains non terminal",
			err:          errors.New("dial tcp timeout"),
			wantCode:     "",
			wantTerminal: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			gotCode, gotTerminal := ClassifyCreateError(tt.err)
			if gotCode != tt.wantCode || gotTerminal != tt.wantTerminal {
				t.Fatalf("ClassifyCreateError(%v) = (%q, %v), want (%q, %v)", tt.err, gotCode, gotTerminal, tt.wantCode, tt.wantTerminal)
			}
		})
	}
}
