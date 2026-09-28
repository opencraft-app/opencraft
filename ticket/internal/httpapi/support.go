package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
	"git.woa.com/wisp/mono/ticket/internal/store"
)

const (
	supportFeedbackMaxFiles      = 5
	supportFeedbackMaxFileBytes  = 50 * 1024 * 1024
	supportFeedbackMaxTotalBytes = 100 * 1024 * 1024
	supportFeedbackMaxBodyBytes  = supportFeedbackMaxTotalBytes + 2*1024*1024
)

type feedbackAttachmentDTO struct {
	ID          string `json:"id"`
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

func generateFeedbackID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "fb_" + hex.EncodeToString(b)
}

func generateFeedbackAttachmentID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "fba_" + hex.EncodeToString(b)
}

func stringPtr(v string) *string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return &v
}

func buildFeedbackSubject(description string) string {
	firstLine := strings.TrimSpace(description)
	if idx := strings.IndexAny(firstLine, "\r\n"); idx >= 0 {
		firstLine = strings.TrimSpace(firstLine[:idx])
	}
	runes := []rune(firstLine)
	if len(runes) <= 80 {
		return firstLine
	}
	return string(runes[:80])
}

func decodeJSONMap(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func supportFeedbackDTO(rec store.SupportFeedback) feedbackRecordDTO {
	attachments := make([]feedbackAttachmentDTO, 0, len(rec.Attachments))
	for _, attachment := range rec.Attachments {
		attachments = append(attachments, feedbackAttachmentDTO{
			ID:          attachment.ID,
			FileName:    attachment.FileName,
			ContentType: attachment.ContentType,
			Size:        attachment.SizeBytes,
			StorageKey:  attachment.ID,
		})
	}
	return feedbackRecordDTO{
		ID:           rec.ID,
		AccountID:    rec.AccountID,
		FeedbackType: rec.FeedbackType,
		OtherText:    stringPtr(rec.OtherText.String),
		Description:  rec.Description,
		Subject:      rec.Subject,
		Status:       rec.Status,
		Source:       rec.Source,
		Site:         rec.Site,
		CreatedAt:    rec.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:    rec.UpdatedAt.UTC().Format(time.RFC3339Nano),
		Attachments:  attachments,
		ContactInfo:  stringPtr(rec.ContactInfo.String),
		Profile:      decodeJSONMap(rec.ProfileJSON.String),
		Category:     rec.Category,
		BugInfo:      decodeJSONMap(rec.BugInfoJSON.String),
	}
}

func trimForm(c *gin.Context, key string) string {
	return strings.TrimSpace(c.PostForm(key))
}

func sanitizeAttachmentFileName(name string) string {
	base := filepath.Base(strings.TrimSpace(name))
	base = strings.Trim(base, ". ")
	if base == "" || base == "." || base == "/" {
		return "attachment"
	}
	return base
}

func detectAttachmentContentType(fileName string, content []byte) string {
	if ext := strings.ToLower(filepath.Ext(fileName)); ext != "" {
		if byExt := mime.TypeByExtension(ext); byExt != "" {
			return byExt
		}
	}
	if len(content) == 0 {
		return "application/octet-stream"
	}
	return http.DetectContentType(content)
}

func readSupportAttachments(c *gin.Context) ([]store.CreateSupportFeedbackAttachmentInput, bool) {
	form, err := c.MultipartForm()
	if err != nil {
		if err == http.ErrNotMultipart {
			return nil, true
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_multipart"})
		return nil, false
	}
	files := form.File["attachments"]
	if len(files) > supportFeedbackMaxFiles {
		c.JSON(http.StatusBadRequest, gin.H{"error": "too_many_attachments"})
		return nil, false
	}

	total := int64(0)
	attachments := make([]store.CreateSupportFeedbackAttachmentInput, 0, len(files))
	for _, header := range files {
		if header.Size > supportFeedbackMaxFileBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "attachment_too_large"})
			return nil, false
		}
		total += header.Size
		if total > supportFeedbackMaxTotalBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "attachments_total_too_large"})
			return nil, false
		}

		file, err := header.Open()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_attachment"})
			return nil, false
		}
		content, err := io.ReadAll(io.LimitReader(file, supportFeedbackMaxFileBytes+1))
		_ = file.Close()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_attachment"})
			return nil, false
		}
		if int64(len(content)) > supportFeedbackMaxFileBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "attachment_too_large"})
			return nil, false
		}
		fileName := sanitizeAttachmentFileName(header.Filename)
		contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
		if contentType == "" {
			contentType = detectAttachmentContentType(fileName, content)
		}
		attachments = append(attachments, store.CreateSupportFeedbackAttachmentInput{
			ID:          generateFeedbackAttachmentID(),
			FileName:    fileName,
			ContentType: contentType,
			SizeBytes:   int64(len(content)),
			Content:     content,
		})
	}
	return attachments, true
}

func registerSupportRoutes(r *gin.Engine, svc *service.Service, agentIDs []string) {
	unconfigured := func(c *gin.Context) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "support_feedback_not_configured"})
	}
	if svc == nil {
		r.POST("/support/feedback/submit", unconfigured)
		r.POST("/support/feedback/presign", unconfigured)
		r.GET("/support/feedback/list", unconfigured)
		r.GET("/support/feedback/attachment/:id", unconfigured)
		r.GET("/support/feedback/sign", unconfigured)
		return
	}

	userGroup := r.Group("/support/feedback", supportUserMiddleware())
	userGroup.POST("/submit", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, supportFeedbackMaxBodyBytes)
		if err := c.Request.ParseMultipartForm(supportFeedbackMaxBodyBytes); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "body_too_large"})
			return
		}

		userID, _ := c.Get("user_id")
		accountID, _ := userID.(string)
		site := trimForm(c, "site")
		if site != "global" {
			site = "cn"
		}
		category := trimForm(c, "category")
		feedbackType := trimForm(c, "feedbackType")
		description := trimForm(c, "description")
		if category == "" || feedbackType == "" || description == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing_required_field"})
			return
		}

		attachments, ok := readSupportAttachments(c)
		if !ok {
			return
		}
		rec, err := svc.CreateSupportFeedback(c.Request.Context(), store.CreateSupportFeedbackInput{
			ID:           generateFeedbackID(),
			AccountID:    accountID,
			Site:         site,
			Category:     category,
			FeedbackType: feedbackType,
			OtherText:    trimForm(c, "otherText"),
			Subject:      buildFeedbackSubject(description),
			Description:  description,
			ContactInfo:  trimForm(c, "contactInfo"),
			ProfileJSON:  trimForm(c, "profile"),
			BugInfoJSON:  trimForm(c, "bugInfo"),
			Attachments:  attachments,
		})
		if err != nil {
			writeErr(c, err)
			return
		}
		c.JSON(http.StatusOK, supportFeedbackDTO(*rec))
	})

	userGroup.POST("/presign", func(c *gin.Context) {
		c.JSON(http.StatusGone, gin.H{"error": "support_feedback_uses_multipart_submit"})
	})

	adminGroup := r.Group("/support/feedback", supportAgentMiddleware(agentIDs))
	adminGroup.GET("/list", func(c *gin.Context) {
		records, err := svc.ListSupportFeedback(c.Request.Context(), c.Query("site"))
		if err != nil {
			writeErr(c, err)
			return
		}
		items := make([]feedbackRecordDTO, 0, len(records))
		for _, record := range records {
			items = append(items, supportFeedbackDTO(record))
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	})
	adminGroup.GET("/attachment/:id", func(c *gin.Context) {
		attachment, err := svc.GetSupportFeedbackAttachment(c.Request.Context(), c.Param("id"))
		if err != nil {
			writeErr(c, err)
			return
		}
		c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": attachment.FileName}))
		c.Data(http.StatusOK, attachment.ContentType, attachment.Content)
	})
	adminGroup.GET("/sign", func(c *gin.Context) {
		id := strings.TrimSpace(c.Query("id"))
		if id == "" {
			id = strings.TrimSpace(c.Query("key"))
		}
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing_attachment_id"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"url": "/support/feedback/attachment/" + id})
	})
}
