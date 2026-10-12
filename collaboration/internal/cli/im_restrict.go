package cli

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	botimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/botim"
	tencentimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/tencentim"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
)

// runIMRestrictCommand 限制或解除一个 IM 身份：限制后不再签发 UserSig、腾讯登录态立即失效，
// 配置了发消息前回调时其消息会被拒绝。SQLite 单写者模式下需要在 serve 停止时执行。
func runIMRestrictCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	var (
		imUserID, adminUserID, secretFile, restBaseURL string
		sdkAppID                                       int
		release                                        bool
	)
	own := make([]string, 0, len(args))
	filtered := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		name, _, hasValue := strings.Cut(strings.TrimLeft(args[index], "-"), "=")
		switch name {
		case "release":
			own = append(own, args[index])
		case "im-user-id", "im-sdk-app-id", "im-admin-user-id", "im-secret-key-file", "im-rest-base-url":
			own = append(own, args[index])
			if !hasValue && index+1 < len(args) {
				own = append(own, args[index+1])
				index++
			}
		default:
			filtered = append(filtered, args[index])
		}
	}
	flags := flag.NewFlagSet("im restrict", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&imUserID, "im-user-id", "", "要限制的腾讯 IM UserID")
	flags.BoolVar(&release, "release", false, "解除限制")
	flags.IntVar(&sdkAppID, "im-sdk-app-id", 0, "腾讯云 IM SDKAppID")
	flags.StringVar(&adminUserID, "im-admin-user-id", "", "腾讯云 IM 管理员 UserID")
	flags.StringVar(&secretFile, "im-secret-key-file", "", "腾讯云 IM SecretKey 文件")
	flags.StringVar(&restBaseURL, "im-rest-base-url", defaultIMRESTBaseURL, "腾讯云 IM REST API 基础 URL")
	if err := flags.Parse(own); err != nil || flags.NArg() != 0 {
		writeCommandError(stderr, apperror.New("CONFIG_INVALID", "im restrict 参数无效", err))
		return 2
	}
	if strings.TrimSpace(imUserID) == "" || sdkAppID <= 0 || strings.TrimSpace(adminUserID) == "" ||
		strings.TrimSpace(secretFile) == "" {
		writeCommandError(stderr, apperror.New("CONFIG_INVALID", "需要 --im-user-id 与完整的腾讯云 IM 配置", nil))
		return 2
	}
	cfg, err := parseDatabaseConfig("im restrict", filtered)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	secret, err := loadTextSecret(secretFile, "腾讯云 IM 密钥")
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	handle, err := database.OpenWriter(ctx, cfg)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	defer handle.Close()
	repository, err := botimadapter.NewEntRepository(handle, idport.UUIDv7{})
	if err != nil {
		writeCommandError(stderr, apperror.New("CONFIG_INVALID", "无法组装 IM 路由仓储", err))
		return 2
	}
	var restrictedAt *time.Time
	if !release {
		now := time.Now().UTC()
		restrictedAt = &now
	}
	if _, err := repository.SetRouteRestricted(ctx, imUserID, restrictedAt); err != nil {
		if errors.Is(err, botimport.ErrNotFound) {
			writeCommandError(stderr, apperror.New("IM_IDENTITY_UNKNOWN", "平台没有该 IM 身份的路由", err))
			return 1
		}
		writeCommandError(stderr, apperror.New("DATABASE_WRITE_FAILED", "无法写入限制状态", err))
		return 1
	}
	if !release {
		userSigs, err := tencentimadapter.NewUserSigIssuer(sdkAppID, secret, clockport.System{})
		if err == nil {
			var provisioner *tencentimadapter.RESTIdentityProvisioner
			provisioner, err = tencentimadapter.NewRESTIdentityProvisioner(tencentimadapter.RESTConfig{
				SDKAppID: sdkAppID, AdminUserID: adminUserID, BaseURL: restBaseURL,
				HTTPClient: &http.Client{Timeout: 15 * time.Second}, Random: rand.Reader,
				AdminSignatures: userSigs, AdminSigTTL: 10 * time.Minute,
			})
			if err == nil {
				err = provisioner.KickIdentity(ctx, imUserID)
			}
		}
		if err != nil {
			writeCommandError(stderr, apperror.New("TENCENT_KICK_FAILED", "已写入限制，但腾讯登录态下线失败，请重试", err))
			return 1
		}
		fmt.Fprintf(stdout, "已限制 %s，并使其腾讯登录态失效\n", imUserID)
		return 0
	}
	fmt.Fprintf(stdout, "已解除 %s 的限制\n", imUserID)
	return 0
}
