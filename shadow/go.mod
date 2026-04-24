module shadow

go 1.25.0

require (
	git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/account v0.0.0
	git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/billing v0.0.0
	git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/cam v0.0.0
	git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common v1.0.1198
	git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/sts v0.0.0
	github.com/google/uuid v1.6.0
	go.opentelemetry.io/otel v1.43.0
	go.opentelemetry.io/otel/exporters/stdout/stdoutlog v0.19.0
	go.opentelemetry.io/otel/log v0.19.0
	go.opentelemetry.io/otel/sdk v1.43.0
	go.opentelemetry.io/otel/sdk/log v0.19.0
	modernc.org/sqlite v1.36.0
)

require (
	git.woa.com/polaris/polaris-go/v2 v2.5.17 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel/metric v1.43.0 // indirect
	go.opentelemetry.io/otel/trace v1.43.0 // indirect
	golang.org/x/exp v0.0.0-20250305212735-054e65f0b394 // indirect
	golang.org/x/sys v0.42.0 // indirect
	modernc.org/libc v1.62.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

replace git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common => ./tencentcloud-sdk-go/tencentcloud/common

replace git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/account => ./tencentcloud-sdk-go/tencentcloud/account

replace git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/billing => ./tencentcloud-sdk-go/tencentcloud/billing

replace git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/cam => ./tencentcloud-sdk-go/tencentcloud/cam

replace git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/sts => ./tencentcloud-sdk-go/tencentcloud/sts

replace git.woa.com/polaris/polaris-go/v2 => ./third_party/polaris-go-v2
