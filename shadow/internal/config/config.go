package config

import (
	"encoding/json"
	"os"
	"time"

	"shadow/internal/cloudladder"
)

type Config struct {
	HTTPAddr       string
	Provider       string
	ShadowPlatform string
	StorageDriver  string
	StorageDSN     string

	Region          string
	AccountEndpoint string
	CAMEndpoint     string
	STSEndpoint     string
	SecretID        string
	SecretKey       string
	CloudLadder     cloudladder.Options

	BillingMode         string
	BillingEndpoint     string
	DianshiEndpoint     string
	RecoveryEndpoint    string
	BillingAPIEndpoint  string
	BillingAPIRegion    string
	BillingSecretID     string
	BillingSecretKey    string
	CallbackToken       string
	PaymentConfirmToken string
	FreeTrialActivityID string
	FreeTrialActID      string
	SubProductCode      string
	AuthCodeTTL         time.Duration
	RequestTimeout      time.Duration
	CaptchaAppID        string
	PackageProducts     []PackageProductConfig
	PackageProductsErr  error
}

type PackageProductConfig struct {
	Code                     string `json:"code"`
	DisplayName              string `json:"display_name"`
	CreditAmount             int64  `json:"credit_amount"`
	Currency                 string `json:"currency"`
	BillingGoodsCategoryID   int64  `json:"billing_goods_category_id"`
	BillingRegion            string `json:"billing_region"`
	BillingZone              string `json:"billing_zone"`
	BillingPayMode           string `json:"billing_pay_mode"`
	ProductCode              string `json:"product_code"`
	SubProductCode           string `json:"sub_product_code"`
	BillingItemTypeCode      string `json:"billing_item_type_code"`
	BillingItemCode          string `json:"billing_item_code"`
	BillingPID               int64  `json:"billing_pid"`
	BillingTimeUnit          string `json:"billing_time_unit"`
	BillingTimeSpan          int64  `json:"billing_time_span"`
	BillingAction            string `json:"billing_action"`
	BillingExtraParamsJSON   string `json:"billing_extra_params_json"`
	BillingGoodsDetailJSON   string `json:"billing_goods_detail_json"`
	RequiresStandardRealname bool   `json:"requires_standard_realname"`
	Enabled                  bool   `json:"enabled"`
	MetadataJSON             string `json:"metadata_json"`
}

func Load() Config {
	packageProducts, packageProductsErr := parsePackageProducts(os.Getenv("SHADOW_PACKAGE_PRODUCTS_JSON"))
	billingSecretID := os.Getenv("SHADOW_BILLING_SECRET_ID")
	if billingSecretID == "" {
		billingSecretID = os.Getenv("SHADOW_SECRET_ID")
	}
	billingSecretKey := os.Getenv("SHADOW_BILLING_SECRET_KEY")
	if billingSecretKey == "" {
		billingSecretKey = os.Getenv("SHADOW_SECRET_KEY")
	}
	paymentConfirmToken := os.Getenv("SHADOW_PAYMENT_CONFIRM_TOKEN")
	if paymentConfirmToken == "" {
		paymentConfirmToken = os.Getenv("SHADOW_CALLBACK_TOKEN")
	}

	return Config{
		HTTPAddr:        envOrDefault("SHADOW_HTTP_ADDR", ":8080"),
		Provider:        envOrDefault("SHADOW_PROVIDER", "fake"),
		ShadowPlatform:  envOrDefault("SHADOW_PLATFORM", "shadow_test"),
		StorageDriver:   envOrDefault("SHADOW_STORAGE_DRIVER", "sqlite"),
		StorageDSN:      envOrDefault("SHADOW_STORAGE_DSN", "file:shadow.db?_pragma=busy_timeout(5000)"),
		Region:          envOrDefault("SHADOW_REGION", "ap-guangzhou"),
		AccountEndpoint: os.Getenv("SHADOW_ACCOUNT_ENDPOINT"),
		CAMEndpoint:     os.Getenv("SHADOW_CAM_ENDPOINT"),
		STSEndpoint:     os.Getenv("SHADOW_STS_ENDPOINT"),
		SecretID:        os.Getenv("SHADOW_SECRET_ID"),
		SecretKey:       os.Getenv("SHADOW_SECRET_KEY"),
		CloudLadder: cloudladder.Options{
			Enabled:        boolFromEnv("SHADOW_CLOUDLADDER_ENABLED"),
			GatewayBaseURL: os.Getenv("SHADOW_CLOUDLADDER_GATEWAY_BASE_URL"),
			Caller:         cloudLadderCaller(),
			Secret:         os.Getenv("SHADOW_CLOUDLADDER_HMAC_SECRET"),
		},
		BillingMode:         envOrDefault("SHADOW_BILLING_MODE", "fake"),
		BillingEndpoint:     os.Getenv("SHADOW_BILLING_ENDPOINT"),
		DianshiEndpoint:     os.Getenv("SHADOW_DIANSHI_ENDPOINT"),
		RecoveryEndpoint:    os.Getenv("SHADOW_BILLING_RECOVERY_ENDPOINT"),
		BillingAPIEndpoint:  envOrDefault("SHADOW_BILLING_API_ENDPOINT", "billing.dev.tencentcloudapi.com"),
		BillingAPIRegion:    envOrDefault("SHADOW_BILLING_API_REGION", "ap-guangzhou"),
		BillingSecretID:     billingSecretID,
		BillingSecretKey:    billingSecretKey,
		CallbackToken:       os.Getenv("SHADOW_CALLBACK_TOKEN"),
		PaymentConfirmToken: paymentConfirmToken,
		FreeTrialActivityID: os.Getenv("SHADOW_FREE_TRIAL_ACTIVITY_ID"),
		FreeTrialActID:      os.Getenv("SHADOW_FREE_TRIAL_ACT_ID"),
		SubProductCode:      envOrDefault("SHADOW_FREE_TRIAL_SUB_PRODUCT_CODE", "sp_tced_saas"),
		AuthCodeTTL:         durationOrDefault("SHADOW_AUTH_CODE_TTL", 10*time.Minute),
		RequestTimeout:      durationOrDefault("SHADOW_REQUEST_TIMEOUT", 10*time.Second),
		CaptchaAppID:        os.Getenv("SHADOW_CAPTCHA_APP_ID"),
		PackageProducts:     packageProducts,
		PackageProductsErr:  packageProductsErr,
	}
}

func cloudLadderCaller() string {
	if value := os.Getenv("SHADOW_CLOUDLADDER_CALLER"); value != "" {
		return value
	}
	if boolFromEnv("SHADOW_CLOUDLADDER_ENABLED") {
		return "shadow"
	}
	return ""
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func boolFromEnv(key string) bool {
	switch os.Getenv(key) {
	case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
		return true
	default:
		return false
	}
}

func durationOrDefault(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return fallback
}

func parsePackageProducts(raw string) ([]PackageProductConfig, error) {
	if raw == "" {
		return nil, nil
	}
	var products []PackageProductConfig
	if err := json.Unmarshal([]byte(raw), &products); err != nil {
		return nil, err
	}
	return products, nil
}
