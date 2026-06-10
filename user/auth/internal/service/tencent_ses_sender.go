package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/ses"
)

type TencentSESSender struct {
	client *ses.Client
	from   string
	logger *slog.Logger
}

func NewTencentSESSender(client *ses.Client, from string, logger *slog.Logger) *TencentSESSender {
	return &TencentSESSender{
		client: client,
		from:   strings.TrimSpace(from),
		logger: logger,
	}
}

func (s *TencentSESSender) SendEmailBindMagicLink(ctx context.Context, to string, confirmURL string) error {
	if s.client == nil {
		return fmt.Errorf("ses client is not configured")
	}
	subject, html, text := buildEmailBindMagicLinkContent(confirmURL)
	result, err := s.client.SendSimpleEmail(ctx, ses.SendSimpleEmailInput{
		From:    s.from,
		To:      to,
		Subject: subject,
		HTML:    html,
		Text:    text,
	})
	if err != nil {
		if s.logger != nil {
			s.logger.WarnContext(ctx, "tencent ses send email failed", "to", to, "from", s.from, "err", err)
		}
		return err
	}
	if s.logger != nil {
		s.logger.InfoContext(ctx, "email bind magic link sent",
			"to", to,
			"message_id", result.MessageID,
			"request_id", result.RequestID,
		)
	}
	return nil
}

func buildEmailBindMagicLinkContent(confirmURL string) (subject string, html string, text string) {
	subject = "[LightVela] 验证你的邮箱"
	html = fmt.Sprintf(`<html><body style="font-family:sans-serif;line-height:1.6;color:#333">
<p>你好，</p>
<p>请点击下方按钮完成 LightVela 账号邮箱绑定：</p>
<p><a href="%[1]s" style="display:inline-block;padding:12px 20px;background:#202020;color:#fff;text-decoration:none;border-radius:999px">验证邮箱</a></p>
<p>如果按钮无法点击，请复制以下链接到浏览器打开：</p>
<p><a href="%[1]s">%[1]s</a></p>
<p>该链接将在 30 分钟内失效。如非本人操作，请忽略此邮件。</p>
</body></html>`, confirmURL)
	text = fmt.Sprintf(
		"请打开以下链接完成 LightVela 邮箱绑定（30 分钟内有效）：\n%s\n\n如非本人操作，请忽略此邮件。",
		confirmURL,
	)
	return subject, html, text
}
