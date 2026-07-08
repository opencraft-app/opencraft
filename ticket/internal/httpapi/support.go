package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tencentyun/cos-go-sdk-v5"

	"git.woa.com/wisp/mono/ticket/internal/config"
	"git.woa.com/wisp/mono/ticket/internal/service"
)

// ──────────────────────────────────────────────────────────
// 反馈系统 COS 客户端（服务端私有凭证，仅本进程持有）
//
// 前端不再持有任何 COS SecretKey：上传/下载权限一律由本服务
// 通过预签名 URL（presigned URL）下发，有效期默认 15 分钟。
// ──────────────────────────────────────────────────────────

// SupportCosClient 是反馈系统使用的服务端 COS 客户端。
type SupportCosClient struct {
	client         *cos.Client // 公网 client：用于下发给前端的预签名 URL（上传/下载）
	internalClient *cos.Client // 内网 client：仅服务端读桶使用（开启全球内网加速时与 client 不同）
	prefix         string
	ttl            time.Duration
}

// rewriteBucketURL 依据加速开关改写 COS 域名（仅识别 <bucket>.cos.<region>.myqcloud.com 形态）：
//   - 均关闭：原样返回。
//   - 仅全球加速：<bucket>.cos.accelerate.myqcloud.com（公网，浏览器可达）。
//   - 全球内网加速（隐含加速）：<bucket>.cos-internal.accelerate.tencentcos.cn（腾讯云内网）。
//
// 内网域名浏览器不可达，绝不能用于下发给前端的预签名 URL；它只服务于服务端读桶。
// 非标准形态（如测试用 mock）原样返回，避免破坏既有配置。
func rewriteBucketURL(raw string, accelerate, internal bool) string {
	if !accelerate && !internal {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	parts := strings.Split(u.Host, ".")
	if len(parts) < 3 || parts[1] != "cos" {
		return raw
	}
	bucket := parts[0]
	var host string
	if internal {
		// 内网全球加速域名后缀是 tencentcos.cn（与公网 myqcloud.com 不同），
		// 例如 lightvela-userfeedback-1251810746.cos-internal.accelerate.tencentcos.cn
		host = bucket + ".cos-internal.accelerate.tencentcos.cn"
	} else {
		host = bucket + ".cos.accelerate.myqcloud.com"
	}
	u.Host = host
	return u.String()
}

// buildCosClient 用给定 BucketURL 与凭证构造服务端 COS 客户端（自动补全 https）。
func buildCosClient(rawURL, secretID, secretKey string) (*cos.Client, error) {
	raw := strings.TrimSpace(rawURL)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	return cos.NewClient(&cos.BaseURL{BucketURL: parsed}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  secretID,
			SecretKey: secretKey,
		},
	}), nil
}

// NewSupportCosClient 构造服务端 COS 客户端；凭证缺失时返回 error，
// 由调用方决定降级为「503 未配置」而非启动失败。
//
// 加速策略：
//   - 预签名 URL（上传/下载，下发给前端浏览器）始终走公网域名：
//     开启全球加速时为 <bucket>.cos.accelerate.myqcloud.com。
//   - 服务端读桶（listFeedback）额外可走全球内网加速
//     <bucket>.cos-internal.accelerate.myqcloud.com（仅当 Internal 开启且本服务在腾讯云内网）。
func NewSupportCosClient(cfg config.SupportCOSConfig) (*SupportCosClient, error) {
	bucketURL := strings.TrimSpace(cfg.BucketURL)
	if bucketURL == "" || strings.TrimSpace(cfg.SecretID) == "" || strings.TrimSpace(cfg.SecretKey) == "" {
		return nil, errors.New("support cos not configured")
	}
	if !strings.Contains(bucketURL, "://") {
		bucketURL = "https://" + bucketURL
	}
	secretID := strings.TrimSpace(cfg.SecretID)
	secretKey := strings.TrimSpace(cfg.SecretKey)

	// 下发给前端的预签名 URL：公网加速域名（浏览器可达）。
	publicURL := rewriteBucketURL(bucketURL, cfg.Accelerate, false)
	// 服务端读桶：全球内网加速（Internal 隐含 Accelerate）。
	internalURL := rewriteBucketURL(bucketURL, cfg.Accelerate || cfg.Internal, cfg.Internal)

	publicClient, err := buildCosClient(publicURL, secretID, secretKey)
	if err != nil {
		return nil, err
	}
	internalClient := publicClient
	if internalURL != publicURL {
		internalClient, err = buildCosClient(internalURL, secretID, secretKey)
		if err != nil {
			return nil, err
		}
	}

	prefix := strings.TrimSpace(cfg.Prefix)
	if prefix == "" {
		prefix = "support-feedback"
	}
	ttl := cfg.SignedTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	return &SupportCosClient{client: publicClient, internalClient: internalClient, prefix: prefix, ttl: ttl}, nil
}

func (c *SupportCosClient) scopedPrefix(site string) string {
	return c.prefix + "/" + site
}

func (c *SupportCosClient) recordKey(id, site string) string {
	return c.scopedPrefix(site) + "/records/" + id + ".json"
}

func (c *SupportCosClient) attachmentKey(id, fileName, site string) string {
	return c.scopedPrefix(site) + "/attachments/" + id + "/" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "-" + safeFileName(fileName)
}

func (c *SupportCosClient) detectSite(key string) string {
	if strings.HasPrefix(key, c.scopedPrefix("global")) {
		return "global"
	}
	return "cn"
}

func safeFileName(name string) string {
	repl := func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '\t', '\n':
			return '-'
		}
		return r
	}
	s := strings.Map(repl, name)
	s = strings.ReplaceAll(s, "--", "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "attachment"
	}
	return s
}

func generateFeedbackID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "fb_" + hex.EncodeToString(b)
}

// ──────────────────────────────────────────────────────────
// 对外 DTO（与前端 SupportFeedbackRecord 字段对齐）
// ──────────────────────────────────────────────────────────

type feedbackAttachmentDTO struct {
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	StorageKey  string `json:"storageKey"`
}

type feedbackRecordDTO struct {
	ID           string                  `json:"id"`
	AccountID    string                  `json:"accountId"`
	FeedbackType string                  `json:"feedbackType"`
	OtherText    *string                 `json:"otherText"`
	Description  string                  `json:"description"`
	Subject      string                  `json:"subject"`
	Status       string                  `json:"status"`
	Source       string                  `json:"source"`
	Site         string                  `json:"site"`
	CreatedAt    string                  `json:"createdAt"`
	UpdatedAt    string                  `json:"updatedAt"`
	Attachments  []feedbackAttachmentDTO `json:"attachments"`
	ContactInfo  *string                 `json:"contactInfo"`
	Profile      map[string]any          `json:"profile,omitempty"`
	Category     string                  `json:"category"`
	BugInfo      map[string]any          `json:"bugInfo,omitempty"`
}

func normalizeAttachment(raw map[string]any) *feedbackAttachmentDTO {
	storageKey, _ := raw["storageKey"].(string)
	if storageKey == "" {
		return nil
	}
	fileName, _ := raw["fileName"].(string)
	if fileName == "" {
		fileName = "attachment"
	}
	contentType, _ := raw["contentType"].(string)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	size, _ := raw["size"].(float64)
	return &feedbackAttachmentDTO{
		FileName:    fileName,
		ContentType: contentType,
		Size:        int64(size),
		StorageKey:  storageKey,
	}
}

func normalizeFeedbackRecord(raw map[string]any, fallbackSite string) *feedbackRecordDTO {
	id, _ := raw["id"].(string)
	if id == "" {
		return nil
	}
	accountID, _ := raw["accountId"].(string)
	if accountID == "" {
		return nil
	}
	feedbackType, _ := raw["feedbackType"].(string)
	if feedbackType == "" {
		return nil
	}
	description, _ := raw["description"].(string)
	if description == "" {
		return nil
	}

	createdAt, _ := raw["createdAt"].(string)
	if createdAt == "" {
		createdAt = time.Now().UTC().Format(time.RFC3339)
	}
	status, _ := raw["status"].(string)
	if status != "reviewing" && status != "resolved" {
		status = "open"
	}
	site, _ := raw["site"].(string)
	if site != "global" && site != "cn" {
		site = fallbackSite
	}

	subject, _ := raw["subject"].(string)
	if subject == "" {
		firstLine := description
		if idx := strings.IndexAny(description, "\r\n"); idx >= 0 {
			firstLine = description[:idx]
		}
		firstLine = strings.TrimSpace(firstLine)
		if len(firstLine) > 80 {
			firstLine = firstLine[:80]
		}
		subject = firstLine
	}

	var otherText *string
	if v, ok := raw["otherText"].(string); ok && v != "" {
		otherText = &v
	}
	var contactInfo *string
	if v, ok := raw["contactInfo"].(string); ok && v != "" {
		contactInfo = &v
	}

	attachments := make([]feedbackAttachmentDTO, 0)
	if arr, ok := raw["attachments"].([]any); ok {
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok {
				if a := normalizeAttachment(m); a != nil {
					attachments = append(attachments, *a)
				}
			}
		}
	}

	var profile map[string]any
	if p, ok := raw["profile"].(map[string]any); ok && len(p) > 0 {
		profile = p
	}

	category, _ := raw["category"].(string)

	var bugInfo map[string]any
	if b, ok := raw["bugInfo"].(map[string]any); ok && len(b) > 0 {
		bugInfo = b
	}

	updatedAt, _ := raw["updatedAt"].(string)
	if updatedAt == "" {
		updatedAt = createdAt
	}

	return &feedbackRecordDTO{
		ID:           id,
		AccountID:    strings.TrimSpace(accountID),
		FeedbackType: strings.TrimSpace(feedbackType),
		OtherText:    otherText,
		Description:  description,
		Subject:      subject,
		Status:       status,
		Source:       "support-page",
		Site:         site,
		CreatedAt:    createdAt,
		UpdatedAt:    updatedAt,
		Attachments:  attachments,
		ContactInfo:  contactInfo,
		Profile:      profile,
		Category:     category,
		BugInfo:      bugInfo,
	}
}

// listFeedback 服务端拉取反馈记录（替代前端直读 COS）。
func (c *SupportCosClient) listFeedback(ctx context.Context, site string) ([]feedbackRecordDTO, error) {
	var prefixes []string
	switch site {
	case "global":
		prefixes = []string{c.scopedPrefix("global") + "/records/"}
	default:
		prefixes = []string{c.scopedPrefix("cn") + "/records/", c.prefix + "/records/"}
	}

	keySet := make(map[string]struct{})
	for _, prefix := range prefixes {
		resp, _, err := c.internalClient.Bucket.Get(ctx, &cos.BucketGetOptions{
			Prefix:  prefix,
			MaxKeys: 1000,
		})
		if err != nil {
			return nil, err
		}
		for _, obj := range resp.Contents {
			// cos-go-sdk-v5 v0.7.73 起 Object.Key 是 string 而非 *string；
			// 空串视为无 key，跳过。
			if obj.Key != "" {
				keySet[obj.Key] = struct{}{}
			}
		}
	}

	records := make([]feedbackRecordDTO, 0, len(keySet))
	for key := range keySet {
		// Object.Get 在当前 SDK 版本要求第三个参数（*ObjectGetOptions），nil 即使用默认。
		objResp, err := c.internalClient.Object.Get(ctx, key, nil)
		if err != nil {
			continue
		}
		var raw map[string]any
		if decErr := json.NewDecoder(objResp.Body).Decode(&raw); decErr != nil {
			objResp.Body.Close()
			continue
		}
		objResp.Body.Close()
		if rec := normalizeFeedbackRecord(raw, c.detectSite(key)); rec != nil {
			records = append(records, *rec)
		}
	}

	sort.Slice(records, func(i, j int) bool {
		return records[i].CreatedAt > records[j].CreatedAt
	})
	return records, nil
}

// ──────────────────────────────────────────────────────────
// 路由注册
// ──────────────────────────────────────────────────────────

type presignRequest struct {
	Site                string   `json:"site"`
	AttachmentFileNames []string `json:"attachmentFileNames"`
}

type presignTarget struct {
	FileName  string `json:"fileName,omitempty"`
	Key       string `json:"key"`
	UploadURL string `json:"uploadUrl"`
}

type presignResponse struct {
	ID          string          `json:"id"`
	Record      presignTarget   `json:"record"`
	Attachments []presignTarget `json:"attachments"`
}

// registerSupportRoutes 挂反馈系统路由。
//   - /presign（用户提交）：supportUserMiddleware，任意登录用户可调用。
//     身份来自上游鉴权网关注入的 X-User-Id / X-Lightclaw-User-ID，不依赖 X-Realm。
//   - /list、/sign（后台读取/下载）：supportAgentMiddleware，仅白名单内运营可调用。
//     身份来自上游鉴权网关在 access: authenticated 路由下注入的 X-User-Id
//     （即运营各自 lightclaw 账号的登录态），不再依赖共享 X-Admin-Token。
//     白名单由 SUPPORT_AGENT_IDS 配置（与 X-User-Id 一致的 lightclaw 用户 ID）。
//   - COS 未配置时所有端点返回 503，避免误导为 404。
func registerSupportRoutes(r *gin.Engine, svc *service.Service, cosClient *SupportCosClient, agentIDs []string) {
	unconfigured := func(c *gin.Context) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "support_cos_not_configured"})
	}
	if cosClient == nil {
		r.POST("/support/feedback/presign", unconfigured)
		r.GET("/support/feedback/list", unconfigured)
		r.GET("/support/feedback/sign", unconfigured)
		return
	}

	// 用户侧：提交反馈（任意登录用户）。
	//
	// 身份来源与运营侧一致：上游鉴权网关在 access: authenticated 路由下
	// 注入的 X-User-Id / X-Lightclaw-User-ID。与老 /tickets 骨架期用的
	// userAuthMiddleware 不同的是：这里不再依赖 X-Realm 头
	// （service-gateway.injectIdentityHeaders 并不注入 X-Realm，
	// 若沿用 userAuthMiddleware 会把合法登录请求恒判 401）。
	userGroup := r.Group("/support/feedback", supportUserMiddleware())
	userGroup.POST("/presign", func(c *gin.Context) {
		var req presignRequest
		if !bindAndValidateJSON(c, &req) {
			return
		}
		site := req.Site
		if site != "global" {
			site = "cn"
		}

		id := generateFeedbackID()
		recordKey := cosClient.recordKey(id, site)
		recordURL, err := cosClient.client.Object.GetPresignedURL2(
			context.Background(), http.MethodPut, recordKey, cosClient.ttl, nil,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "presign_failed"})
			return
		}

		names := req.AttachmentFileNames
		if len(names) > 20 {
			names = names[:20]
		}
		attachments := make([]presignTarget, 0, len(names))
		for _, name := range names {
			ak := cosClient.attachmentKey(id, name, site)
			au, err := cosClient.client.Object.GetPresignedURL2(
				context.Background(), http.MethodPut, ak, cosClient.ttl, nil,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "presign_failed"})
				return
			}
			attachments = append(attachments, presignTarget{
				FileName:  name,
				Key:       ak,
				UploadURL: au.String(),
			})
		}

		c.JSON(http.StatusOK, presignResponse{
			ID:          id,
			Record:      presignTarget{Key: recordKey, UploadURL: recordURL.String()},
			Attachments: attachments,
		})
	})

	// 运营侧：查看全量反馈、下载附件（需运营白名单内用户）。
	adminGroup := r.Group("/support/feedback", supportAgentMiddleware(agentIDs))
	adminGroup.GET("/list", func(c *gin.Context) {
		site := c.Query("site")
		records, err := cosClient.listFeedback(c.Request.Context(), site)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "list_failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": records})
	})

	adminGroup.GET("/sign", func(c *gin.Context) {
		key := strings.TrimSpace(c.Query("key"))
		if key == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing_key"})
			return
		}
		u, err := cosClient.client.Object.GetPresignedURL2(
			context.Background(), http.MethodGet, key, cosClient.ttl, nil,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "sign_failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"url": u.String()})
	})
}
