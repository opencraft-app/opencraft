// Package website TCB 环境动态发现（workers 侧）
// 通过 COS Service API 列出主账号下所有桶，过滤 TCB 静态托管桶，
// 从桶名解析 env_id 和 app_id，统一用主账号密钥做 COS 凭据。
package website

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

// TCBEnvConfig 描述一个动态发现的 TCB 环境
type TCBEnvConfig struct {
	EnvID     string
	AppID     string
	COSBucket string
	COSRegion string
}

const tcbEnvCacheTTL = 5 * time.Minute

// parseTCBBucketName 从 TCB 静态托管桶名解析 env_id 和 app_id
// 桶名格式: {prefix}-static-{env_id}-{app_id}
// 例: 022a-static-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746
func parseTCBBucketName(bucketName string) (envID, appID string, ok bool) {
	idx := strings.LastIndex(bucketName, "-")
	if idx == -1 {
		return "", "", false
	}
	appID = bucketName[idx+1:]
	if len(appID) < 5 {
		return "", "", false
	}
	for _, c := range appID {
		if c < '0' || c > '9' {
			return "", "", false
		}
	}

	withoutAppID := bucketName[:idx]
	staticMarker := "-static-"
	sIdx := strings.Index(withoutAppID, staticMarker)
	if sIdx == -1 {
		return "", "", false
	}
	envID = withoutAppID[sIdx+len(staticMarker):]
	if envID == "" {
		return "", "", false
	}
	return envID, appID, true
}

// getMainAccountSecrets 读取主账号密钥
func getMainAccountSecrets() (string, string) {
	return os.Getenv("TENCENT_SECRET_ID"), os.Getenv("TENCENT_SECRET_KEY")
}

// discoverTCBEnvs 调 COS Service API 列出所有桶，过滤出 TCB 静态托管桶
func discoverTCBEnvs() ([]TCBEnvConfig, error) {
	secretID, secretKey := getMainAccountSecrets()
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("TENCENT_SECRET_ID/TENCENT_SECRET_KEY not set")
	}

	client := cos.NewClient(&cos.BaseURL{}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  secretID,
			SecretKey: secretKey,
		},
	})

	result, _, err := client.Service.Get(context.Background())
	if err != nil {
		return nil, fmt.Errorf("list COS buckets: %w", err)
	}

	var envs []TCBEnvConfig
	for _, b := range result.Buckets {
		envID, appID, ok := parseTCBBucketName(b.Name)
		if !ok {
			continue
		}
		envs = append(envs, TCBEnvConfig{
			EnvID:     envID,
			AppID:     appID,
			COSBucket: b.Name,
			COSRegion: b.Region,
		})
	}
	return envs, nil
}

// tcbEnvCache 全局缓存
var (
	tcbEnvs     []TCBEnvConfig
	tcbEnvsMu   sync.RWMutex
	tcbEnvsTime time.Time
)

// getTCBEnvs 返回缓存的或新发现的 TCB 环境列表
func getTCBEnvs() ([]TCBEnvConfig, error) {
	tcbEnvsMu.RLock()
	if time.Since(tcbEnvsTime) < tcbEnvCacheTTL && len(tcbEnvs) > 0 {
		out := make([]TCBEnvConfig, len(tcbEnvs))
		copy(out, tcbEnvs)
		tcbEnvsMu.RUnlock()
		return out, nil
	}
	tcbEnvsMu.RUnlock()

	tcbEnvsMu.Lock()
	defer tcbEnvsMu.Unlock()

	if time.Since(tcbEnvsTime) < tcbEnvCacheTTL && len(tcbEnvs) > 0 {
		out := make([]TCBEnvConfig, len(tcbEnvs))
		copy(out, tcbEnvs)
		return out, nil
	}

	envs, err := discoverTCBEnvs()
	if err != nil {
		if len(tcbEnvs) > 0 {
			log.Printf("TCB env discovery failed, using stale cache: %v", err)
			out := make([]TCBEnvConfig, len(tcbEnvs))
			copy(out, tcbEnvs)
			return out, nil
		}
		return nil, err
	}

	tcbEnvs = envs
	tcbEnvsTime = time.Now()
	log.Printf("discovered %d TCB environments", len(envs))
	return envs, nil
}

// getTCBEnvByID 根据 env_id 查找环境配置
func getTCBEnvByID(envID string) *TCBEnvConfig {
	envs, err := getTCBEnvs()
	if err != nil {
		return nil
	}
	for i := range envs {
		if envs[i].EnvID == envID {
			return &envs[i]
		}
	}
	return nil
}

// newCosClientFromEnv 根据发现的 TCB 环境创建 COS 客户端（用主账号密钥）
func newCosClientFromEnv(env *TCBEnvConfig) *cosClient {
	if env == nil || env.COSBucket == "" || env.COSRegion == "" {
		return nil
	}
	secretID, secretKey := getMainAccountSecrets()
	if secretID == "" || secretKey == "" {
		return nil
	}
	u, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", env.COSBucket, env.COSRegion))
	if err != nil {
		return nil
	}
	return &cosClient{
		bucket: env.COSBucket,
		region: env.COSRegion,
		envID:  env.EnvID,
		client: cos.NewClient(&cos.BaseURL{BucketURL: u}, &http.Client{
			Transport: &cos.AuthorizationTransport{
				SecretID:  secretID,
				SecretKey: secretKey,
			},
		}),
	}
}
