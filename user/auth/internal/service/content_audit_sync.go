package service

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func (s *Service) auditNameSynchronously(ctx context.Context, userID string, name string) error {
	requestID, err := newContentAuditRequestID(contentauditBizTypeUserName, userID)
	if err != nil {
		return err
	}
	result, err := submitContentAuditTask(ctx, s.contentAuditClient, s.now, ContentAuditTask{
		BizType:     contentauditBizTypeUserName,
		BizID:       strings.TrimSpace(userID),
		BizDetail:   "name",
		ProductID:   strings.TrimSpace(s.contentAudit.ProductID),
		SID:         strings.TrimSpace(s.contentAudit.UserSID),
		ContentText: strings.TrimSpace(name),
		MediaType:   contentauditMediaTypeText,
		RequestID:   requestID,
	})
	if err != nil {
		return fmt.Errorf("submit name content audit: %w", err)
	}
	return contentAuditSyncError(result, "昵称")
}

func (s *Service) auditAvatarSynchronously(ctx context.Context, userID string, objectKey string, contentURL string) error {
	requestID, err := newContentAuditRequestID(contentauditBizTypeUserAvatar, userID)
	if err != nil {
		return err
	}
	result, err := submitContentAuditTask(ctx, s.contentAuditClient, s.now, ContentAuditTask{
		BizType:     contentauditBizTypeUserAvatar,
		BizID:       strings.TrimSpace(userID),
		BizDetail:   "avatar",
		ProductID:   strings.TrimSpace(s.contentAudit.ProductID),
		SID:         strings.TrimSpace(s.contentAudit.UserSID),
		ContentText: strings.TrimSpace(objectKey),
		ContentURL:  strings.TrimSpace(contentURL),
		MediaType:   contentauditMediaTypeImage,
		RequestID:   requestID,
	})
	if err != nil {
		return fmt.Errorf("submit avatar content audit: %w", err)
	}
	return contentAuditSyncError(result, "头像")
}

func newContentAuditRequestID(bizType string, bizID string) (string, error) {
	suffix, err := newPrefixedID("ca")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("lightclaw-%s-%s-%s", strings.TrimSpace(bizType), strings.TrimSpace(bizID), suffix), nil
}

func contentAuditSyncError(result contentAuditSubmitResult, label string) error {
	switch result.Decision {
	case contentAuditDecisionPass:
		return nil
	case contentAuditDecisionReject:
		return newError("content_audit_rejected", label+"未通过审核，请修改后重试。", http.StatusBadRequest)
	default:
		return newError("content_audit_no_sync_result", label+"审核未返回同步结果，请稍后重试。", http.StatusServiceUnavailable)
	}
}
