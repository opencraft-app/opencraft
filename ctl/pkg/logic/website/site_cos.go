package website

import (
	"os"
	"strings"
)

// 站点存储配置。
//
// 一期用 CloudBase 托管时，站点分散在多个 TCB 环境，需要环境发现、容量统计和
// 超限自动切换（tcb_env.go，361 行）。二期改为自建单桶 + sites/{siteID}/ 前缀
// 分租户，那套机制整体删除，只剩下面这几个配置读取。
//
// 桶名、地域和密钥全部走环境变量而不是常量：这样将来把用户站点迁到独立主账号，
// 是改配置加一次数据迁移，而不是改代码。

func siteCOSBucket() (bucket string, region string) {
	return strings.TrimSpace(os.Getenv("WEBSITE_COS_BUCKET")),
		strings.TrimSpace(os.Getenv("WEBSITE_COS_REGION"))
}

func siteCOSSecrets() (secretID string, secretKey string) {
	return strings.TrimSpace(os.Getenv("TENCENT_SECRET_ID")),
		strings.TrimSpace(os.Getenv("TENCENT_SECRET_KEY"))
}
