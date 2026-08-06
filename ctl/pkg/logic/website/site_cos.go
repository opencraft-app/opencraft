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

// siteCOSSecrets 读取用户站点桶的访问凭据。
//
// 优先站点专用的 WEBSITE_COS_SECRET_ID/KEY，缺失时才回落到共享平台凭据。
// 这个优先级在 ctl 尤其要紧：ctl 用这套凭据签发上传用的预签名 URL，而预签名 URL
// 是直接交到用户手上的，签名所用的 AK 权限越小越好——共享平台凭据能操作的远不止
// 这一个桶。回落只是过渡期的兜底（集群里 site-gateway 目前就只有这一套），
// deployer 和 site-gateway 用的是同一个优先级，三处必须同时切换，否则会出现
// 「换了 deployer 的凭据、预签名还在用大权限」这种半吊子状态。
func siteCOSSecrets() (secretID string, secretKey string) {
	secretID = strings.TrimSpace(os.Getenv("WEBSITE_COS_SECRET_ID"))
	secretKey = strings.TrimSpace(os.Getenv("WEBSITE_COS_SECRET_KEY"))
	if secretID != "" && secretKey != "" {
		return secretID, secretKey
	}
	return strings.TrimSpace(os.Getenv("TENCENT_SECRET_ID")),
		strings.TrimSpace(os.Getenv("TENCENT_SECRET_KEY"))
}
