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
	if task.MediaType == contentauditMediaTypeImage || task.BizType == contentauditBizTypeUserAvatar {
		return w.submitImageTask(ctx, task)
	}
	return w.submitTextTask(ctx, task)
}

func (w *ContentAuditWorker) submitTextTask(ctx context.Context, task ContentAuditTask) error {
	contentText := strings.TrimSpace(task.ContentText)
	if contentText == "" {
		return fmt.Errorf("content audit task %d has empty content", task.ID)
	}
	requestID := fmt.Sprintf("lightclaw-%s-%s-%d", task.BizType, task.BizID, task.ID)
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
				Msg: contentaudit.RequestMsg{UiPostTime: uint64(w.now().Unix())},
				Media: contentaudit.RequestMedia{Text: []contentaudit.RequestText{
					{StrContent: encoded},
				}},
			},
		},
	}
	resp, err := w.client.CreateTextTask(ctx, req)
	if err != nil {
		return err
	}
	return w.applySubmitResponse(ctx, task, requestID, resp)
}

func (w *ContentAuditWorker) submitImageTask(ctx context.Context, task ContentAuditTask) error {
	contentURL := strings.TrimSpace(task.ContentURL)
	if contentURL == "" {
		return fmt.Errorf("content audit task %d has empty image url", task.ID)
	}
	requestID := fmt.Sprintf("lightclaw-%s-%s-%d", task.BizType, task.BizID, task.ID)
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
				Msg: contentaudit.RequestMsg{UiPostTime: uint64(w.now().Unix())},
				Media: contentaudit.RequestMedia{Pic: []contentaudit.RequestPic{
					{StrURL: contentURL},
				}},
			},
		},
	}
	resp, err := w.client.CreateImageTask(ctx, req)
	if err != nil {
		return err
	}
	return w.applySubmitResponse(ctx, task, requestID, resp)
}

func (w *ContentAuditWorker) applySubmitResponse(ctx context.Context, task ContentAuditTask, requestID string, resp *contentaudit.CreateTextTaskResponse) error {
	if resp != nil && resp.Response.Data != nil && resp.Response.Data.Result != nil {
		result := resp.Response.Data.Result
		switch result.ResultCode {
		case contentaudit.ResultCodeMalicious:
			return w.store.MarkContentAuditTaskFailed(ctx, task.ID, requestID, int(result.ResultCode), int(result.ResultType), result.ResultMsg, w.now())
		case contentaudit.ResultCodePass:
			return w.store.MarkContentAuditTaskPassed(ctx, task.ID, requestID, "sync", w.now())
		}
	}
	return w.store.MarkContentAuditTaskSubmitted(ctx, task.ID, requestID, w.now())
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
