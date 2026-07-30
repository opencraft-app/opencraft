package notify

import (
	"fmt"
	"strings"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

func validateInventory(environment string, inv config.NotifyInventory) error {
	if !inv.Enabled {
		return nil
	}
	if strings.TrimSpace(inv.DBSecretName) == "" {
		return fmt.Errorf("notify db_secret_name is required")
	}
	if strings.TrimSpace(inv.DBUser) == "" {
		return fmt.Errorf("notify db_user is required")
	}
	if inv.DBHost == "" || inv.DBPort < 1 || inv.RedisHost == "" || inv.RedisPort < 1 {
		return fmt.Errorf("notify DB and Redis endpoints are required")
	}
	if inv.VPCID == "" || inv.SubnetID == "" || inv.CLSLogsetID == "" || inv.CLSTopicID == "" {
		return fmt.Errorf("notify VPC, subnet, and CLS IDs are required")
	}
	if strings.TrimSpace(inv.SMSSDKAppID) == "" || strings.TrimSpace(inv.SMSSignName) == "" || strings.TrimSpace(inv.SMSTemplateID) == "" {
		return fmt.Errorf("notify SMS app ID, sign, and template ID are required")
	}
	if strings.TrimSpace(inv.ScannerFunctionName) == "" || strings.TrimSpace(inv.WorkerFunctionName) == "" {
		return fmt.Errorf("notify scanner and worker function names are required")
	}
	if inv.SMSQPS <= 0 || inv.SMSBurst < 1 {
		return fmt.Errorf("notify sms_qps must be positive and sms_burst at least 1")
	}
	if inv.ScanPageSize < 1 || inv.ScanPageSize > 1000 {
		return fmt.Errorf("notify scan_page_size must be between 1 and 1000")
	}
	if inv.WorkerBatchSize < 1 || inv.WorkerBatchSize > 200 {
		return fmt.Errorf("notify worker_batch_size must be between 1 and 200")
	}
	if inv.WorkerMaxMessages < 1 {
		return fmt.Errorf("notify worker_max_messages must be positive")
	}
	if inv.ExpiryWindowsDays != "7,0" {
		return fmt.Errorf("notify expiry_windows_days must be 7,0")
	}
	if environment == "shprod" && inv.TestAllowlistEnabled {
		return fmt.Errorf("notify test allowlist must be disabled in shprod")
	}
	if environment != "shprod" && !inv.TestAllowlistEnabled {
		return fmt.Errorf("notify test allowlist must be enabled outside shprod")
	}
	if strings.TrimSpace(inv.ScannerCron) == "" || strings.TrimSpace(inv.WorkerCron) == "" {
		return fmt.Errorf("notify scanner_cron and worker_cron are required")
	}
	return nil
}
