package httpapi

import (
	"context"
	"log/slog"
	"strings"
	"time"
)

const oauthAvatarSyncTimeout = 3 * time.Second

type oauthAvatarLogger interface {
	Warn(msg string, keysAndValues ...any)
}

func (h *Handler) syncOAuthAvatar(ctx context.Context, logger oauthAvatarLogger, provider string, userID string, avatarURL string, avatarSource string) {
	if h == nil || h.service == nil || h.avatarStore == nil || strings.TrimSpace(avatarURL) == "" || strings.TrimSpace(avatarSource) == "upload" {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}

	avatarCtx, cancel := context.WithTimeout(ctx, oauthAvatarSyncTimeout)
	defer cancel()

	objectKey, syncErr := h.avatarStore.SyncRemoteAvatar(avatarCtx, userID, avatarURL)
	if syncErr != nil {
		logger.Warn(provider+" oauth avatar sync failed", "user_id", userID, "err", syncErr)
		return
	}
	if _, persistErr := h.service.SetUserAvatar(avatarCtx, userID, objectKey, "oauth_"+provider); persistErr != nil {
		logger.Warn(provider+" oauth avatar persist failed", "user_id", userID, "err", persistErr)
	}
}
