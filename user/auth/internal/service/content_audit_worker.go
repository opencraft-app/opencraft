package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
)

type ContentAuditClient interface {
	CreateTextTask(ctx context.Context, req contentaudit.CreateTextTaskRequest) (*contentaudit.CreateTextTaskResponse, error)
	CreateImageTask(ctx context.Context, req contentaudit.CreateImageTaskRequest) (*contentaudit.CreateTextTaskResponse, error)
}

type ContentAuditWorker struct {
	store          Store
	client         ContentAuditClient
	config         ContentAuditConfig
	now            func() time.Time
	logger         *slog.Logger
	timeoutMinutes int
}

type ContentAuditWorkerOptions struct {
	Now            func() time.Time
	Logger         *slog.Logger
	TimeoutMinutes int
}

type contentAuditDecision string

const (
	contentAuditDecisionPass    contentAuditDecision = "pass"
	contentAuditDecisionReject  contentAuditDecision = "reject"
	contentAuditDecisionPending contentAuditDecision = "pending"
)

type contentAuditSubmitResult struct {
	Decision   contentAuditDecision
	RequestID  string
	ResultCode int
	ResultType int
	ResultMsg  string
}

func NewContentAuditWorker(store Store, client ContentAuditClient, config ContentAuditConfig, opts ContentAuditWorkerOptions) *ContentAuditWorker {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	timeoutMinutes := opts.TimeoutMinutes
	if timeoutMinutes <= 0 {
		timeoutMinutes = contentaudit.DefaultTimeoutMinutes
	}
	return &ContentAuditWorker{
		store:          store,
		client:         client,
		config:         config,
		now:            now,
		logger:         logger,
		timeoutMinutes: timeoutMinutes,
	}
}

func (w *ContentAuditWorker) Run(ctx context.Context, interval time.Duration, batchSize int) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := w.RunOnce(ctx, batchSize); err != nil {
			w.logger.Warn("content audit worker batch failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *ContentAuditWorker) RunOnce(ctx context.Context, batchSize int) error {
	if w.store == nil || w.client == nil || !w.config.ready() {
		return nil
	}
	if batchSize <= 0 {
		batchSize = 20
	}
	tasks, err := w.store.ListPendingContentAuditTasks(ctx, batchSize)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if err := w.submitTask(ctx, task); err != nil {
			w.logger.Warn("content audit submit failed", "task_id", task.ID, "biz_type", task.BizType, "err", err)
			_ = w.store.MarkContentAuditTaskError(ctx, task.ID, err.Error(), w.now())
		}
	}
	cutoff := w.now().Add(-time.Duration(w.timeoutMinutes) * time.Minute)
	timeoutTasks, err := w.store.ListTimeoutContentAuditTasks(ctx, cutoff, 100)
	if err != nil {
		return err
	}
	for _, task := range timeoutTasks {
		requestID := strings.TrimSpace(task.RequestID)
		if err := w.store.MarkContentAuditTaskPassed(ctx, task.ID, requestID, "timeout", w.now()); err != nil {
			w.logger.Warn("content audit timeout pass failed", "task_id", task.ID, "request_id", requestID, "err", err)
		}
	}
	return nil
}

func (w *ContentAuditWorker) submitTask(ctx context.Context, task ContentAuditTask) error {
	result, err := submitContentAuditTask(ctx, w.client, w.now, w.logger, "async-worker", task)
	if err != nil {
		return err
	}
	return w.applySubmitResult(ctx, task, result)
}

func submitContentAuditTask(ctx context.Context, client ContentAuditClient, now func() time.Time, logger *slog.Logger, mode string, task ContentAuditTask) (contentAuditSubmitResult, error) {
	if logger == nil {
		logger = slog.Default()
	}
	requestID := contentAuditTaskRequestID(task)
	mediaType := strings.TrimSpace(task.MediaType)
	if task.MediaType == contentauditMediaTypeImage || task.BizType == contentauditBizTypeUserAvatar {
		mediaType = contentauditMediaTypeImage
	} else if mediaType == "" {
		mediaType = contentauditMediaTypeText
	}
	logAttrs := []any{
		"mode", strings.TrimSpace(mode),
		"task_id", task.ID,
		"biz_type", strings.TrimSpace(task.BizType),
		"biz_detail", strings.TrimSpace(task.BizDetail),
		"biz_id", strings.TrimSpace(task.BizID),
		"media_type", mediaType,
		"request_id", requestID,
		"product_id", strings.TrimSpace(task.ProductID),
		"sid", strings.TrimSpace(task.SID),
	}
	if mediaType == contentauditMediaTypeImage {
		logAttrs = append(logAttrs, "content_url_present", strings.TrimSpace(task.ContentURL) != "")
	}
	logger.Info("content audit submit started", logAttrs...)

	var (
		result contentAuditSubmitResult
		err    error
	)
	if mediaType == contentauditMediaTypeImage {
		result, err = submitImageContentAuditTask(ctx, client, now, task, requestID)
	} else {
		result, err = submitTextContentAuditTask(ctx, client, now, task, requestID)
	}
	if err != nil {
		logger.Warn("content audit submit failed", append(logAttrs, "err", err)...)
		return contentAuditSubmitResult{}, err
	}
	logger.Info("content audit submit completed", append(
		logAttrs,
		"decision", string(result.Decision),
		"result_code", result.ResultCode,
		"result_type", result.ResultType,
		"result_msg", strings.TrimSpace(result.ResultMsg),
	)...)
	return result, nil
}

func submitTextContentAuditTask(ctx context.Context, client ContentAuditClient, now func() time.Time, task ContentAuditTask, requestID string) (contentAuditSubmitResult, error) {
	contentText := strings.TrimSpace(task.ContentText)
	if contentText == "" {
		return contentAuditSubmitResult{}, fmt.Errorf("content audit task %d has empty content", task.ID)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(contentText))
	req := contentaudit.CreateTextTaskRequest{
		ProductID: task.ProductID,
		SID:       task.SID,
		RequestID: requestID,
		Data: contentaudit.CreateTextTaskRequestData{
			Comm: contentaudit.RequestComm{UlUin: 0},
			ID:   contentaudit.RequestID{StrMsgID: requestID},
			Content: contentaudit.RequestContent{
				User: contentaudit.RequestUser{
					StrUin:     task.BizID,
					UiAcntType: 7,
					StrNick:    contentText,
				},
				Msg: contentaudit.RequestMsg{UiPostTime: uint64(now().Unix())},
				Media: contentaudit.RequestMedia{Text: []contentaudit.RequestText{
					{StrContent: encoded},
				}},
			},
		},
	}
	resp, err := client.CreateTextTask(ctx, req)
	if err != nil {
		return contentAuditSubmitResult{}, err
	}
	return classifyContentAuditSubmitResponse(requestID, resp), nil
}

func submitImageContentAuditTask(ctx context.Context, client ContentAuditClient, now func() time.Time, task ContentAuditTask, requestID string) (contentAuditSubmitResult, error) {
	contentURL := strings.TrimSpace(task.ContentURL)
	if contentURL == "" {
		return contentAuditSubmitResult{}, fmt.Errorf("content audit task %d has empty image url", task.ID)
	}
	req := contentaudit.CreateImageTaskRequest{
		ProductID: task.ProductID,
		SID:       task.SID,
		RequestID: requestID,
		Data: contentaudit.CreateTextTaskRequestData{
			Comm: contentaudit.RequestComm{UlUin: 0},
			ID:   contentaudit.RequestID{StrMsgID: requestID},
			Content: contentaudit.RequestContent{
				User: contentaudit.RequestUser{
					StrUin:     task.BizID,
					UiAcntType: 7,
					StrHeadUrl: contentURL,
				},
				Msg: contentaudit.RequestMsg{UiPostTime: uint64(now().Unix())},
				Media: contentaudit.RequestMedia{Pic: []contentaudit.RequestPic{
					{StrURL: contentURL},
				}},
			},
		},
	}
	resp, err := client.CreateImageTask(ctx, req)
	if err != nil {
		return contentAuditSubmitResult{}, err
	}
	return classifyContentAuditSubmitResponse(requestID, resp), nil
}

func contentAuditTaskRequestID(task ContentAuditTask) string {
	if requestID := strings.TrimSpace(task.RequestID); requestID != "" {
		return requestID
	}
	return fmt.Sprintf("lightclaw-%s-%s-%d", task.BizType, task.BizID, task.ID)
}

func classifyContentAuditSubmitResponse(requestID string, resp *contentaudit.CreateTextTaskResponse) contentAuditSubmitResult {
	result := contentAuditSubmitResult{
		Decision:  contentAuditDecisionPending,
		RequestID: strings.TrimSpace(requestID),
	}
	if resp != nil && resp.Response.Data != nil && resp.Response.Data.Result != nil {
		auditResult := resp.Response.Data.Result
		result.ResultCode = int(auditResult.ResultCode)
		result.ResultType = int(auditResult.ResultType)
		result.ResultMsg = auditResult.ResultMsg
		switch auditResult.ResultCode {
		case contentaudit.ResultCodeMalicious:
			result.Decision = contentAuditDecisionReject
		case contentaudit.ResultCodePass:
			result.Decision = contentAuditDecisionPass
		}
	}
	return result
}

func (w *ContentAuditWorker) applySubmitResult(ctx context.Context, task ContentAuditTask, result contentAuditSubmitResult) error {
	switch result.Decision {
	case contentAuditDecisionReject:
		return w.store.MarkContentAuditTaskFailed(ctx, task.ID, result.RequestID, result.ResultCode, result.ResultType, result.ResultMsg, w.now())
	case contentAuditDecisionPass:
		return w.store.MarkContentAuditTaskPassed(ctx, task.ID, result.RequestID, "sync", w.now())
	default:
		return w.store.MarkContentAuditTaskSubmitted(ctx, task.ID, result.RequestID, w.now())
	}
}

func (s *Service) HandleContentAuditCallback(ctx context.Context, rawBody []byte) error {
	var req contentaudit.CallbackRequest
	if err := json.Unmarshal(rawBody, &req); err != nil {
		return fmt.Errorf("decode content audit callback: %w", err)
	}
	requestID := strings.TrimSpace(req.Res.ResID.StrMsgID)
	if requestID == "" {
		return nil
	}
	task, err := s.store.FindContentAuditTaskByRequestID(ctx, requestID)
	if err != nil || task == nil || isTerminalAuditStatus(task.Status) {
		return err
	}
	resultCode := int(req.Res.UiResultCode)
	resultType := int(req.Res.UiResultType)
	if resultCode == contentaudit.ResultCodeMalicious {
		return s.store.MarkContentAuditTaskFailed(ctx, task.ID, requestID, resultCode, resultType, string(rawBody), s.now())
	}
	return s.store.MarkContentAuditTaskPassed(ctx, task.ID, requestID, "callback", s.now())
}
