package cli

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	cosadapter "chatserver/internal/adapters/tencent/cos"
	"chatserver/internal/apperror"
	update "chatserver/internal/computerupdate"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	"chatserver/internal/securefile"
	updatetransport "chatserver/internal/transport/computerupdate"
	httptransport "chatserver/internal/transport/http"
)

type computerUpdateServeConfig struct {
	listenAddress             string
	stateDirectory            string
	releaseRoot               string
	releasePublicKeyFile      string
	channelKeyID              string
	channelPrivateKeyFile     string
	host                      string
	origin                    string
	trustedProxyCIDRs         []netip.Prefix
	tencentCloudSecretIDFile  string
	tencentCloudSecretKeyFile string
	tencentCloudTokenFile     string
	computerArtifactBucket    string
	computerArtifactRegion    string
	urlTTL                    time.Duration
}

func runComputerUpdateCommand(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
) int {
	if len(args) == 0 || args[0] != "serve" {
		writeComputerUpdateUsage(stderr)
		return 2
	}
	cfg, err := parseComputerUpdateServeConfig(args[1:])
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	if err := serveComputerUpdate(ctx, cfg, stdout); err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	return 0
}

func parseComputerUpdateServeConfig(args []string) (computerUpdateServeConfig, error) {
	var cfg computerUpdateServeConfig
	var trusted repeatedStrings
	flags := flag.NewFlagSet("computer-update serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.listenAddress, "listen", "127.0.0.1:8090", "监听地址")
	flags.StringVar(&cfg.stateDirectory, "state-dir", "", "Channel 状态目录")
	flags.StringVar(&cfg.releaseRoot, "release-root", "", "已验证 Release Set 根目录")
	flags.StringVar(&cfg.releasePublicKeyFile, "release-public-key-file", "", "Release 公钥文件")
	flags.StringVar(&cfg.channelKeyID, "channel-key-id", "", "Channel 签名密钥 ID")
	flags.StringVar(&cfg.channelPrivateKeyFile, "channel-private-key-file", "", "Channel Ed25519 私钥文件")
	flags.StringVar(&cfg.host, "host", "", "Ingress Host")
	flags.StringVar(&cfg.origin, "origin", "", "运营页面 Origin")
	flags.Var(&trusted, "trusted-proxy-cidr", "可信 Ingress CIDR，可重复")
	flags.StringVar(&cfg.tencentCloudSecretIDFile, "tencent-cloud-secret-id-file", "", "腾讯云 SecretId 文件")
	flags.StringVar(&cfg.tencentCloudSecretKeyFile, "tencent-cloud-secret-key-file", "", "腾讯云 SecretKey 文件")
	flags.StringVar(&cfg.tencentCloudTokenFile, "tencent-cloud-security-token-file", "", "腾讯云临时 SecurityToken 文件")
	flags.StringVar(&cfg.computerArtifactBucket, "computer-artifact-bucket", "", "Computer COS Bucket")
	flags.StringVar(&cfg.computerArtifactRegion, "computer-artifact-region", "", "Computer COS Region")
	flags.DurationVar(&cfg.urlTTL, "url-ttl", 5*time.Minute, "制品预签名 URL 有效期")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update 命令参数无效", err)
	}
	for _, value := range []*string{
		&cfg.stateDirectory, &cfg.releaseRoot, &cfg.releasePublicKeyFile,
		&cfg.channelPrivateKeyFile, &cfg.tencentCloudSecretIDFile,
		&cfg.tencentCloudSecretKeyFile,
	} {
		*value = filepath.Clean(strings.TrimSpace(*value))
		if !filepath.IsAbs(*value) {
			return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update 文件路径必须是绝对路径", nil)
		}
	}
	if cfg.tencentCloudTokenFile != "" {
		cfg.tencentCloudTokenFile = filepath.Clean(strings.TrimSpace(cfg.tencentCloudTokenFile))
		if !filepath.IsAbs(cfg.tencentCloudTokenFile) {
			return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update SecurityToken 路径必须是绝对路径", nil)
		}
	}
	if err := validateListenAddress(cfg.listenAddress); err != nil ||
		len(trusted) == 0 || cfg.urlTTL < 2*time.Minute || cfg.urlTTL > 5*time.Minute {
		return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update 服务参数无效", err)
	}
	cfg.host = strings.ToLower(strings.TrimSpace(cfg.host))
	cfg.origin = strings.TrimSpace(cfg.origin)
	parsedOrigin, err := url.Parse(cfg.origin)
	if err != nil || parsedOrigin.Scheme != "https" || parsedOrigin.User != nil ||
		parsedOrigin.Hostname() != cfg.host || parsedOrigin.Port() != "" ||
		parsedOrigin.Path != "" || parsedOrigin.RawQuery != "" || parsedOrigin.Fragment != "" ||
		cfg.origin != "https://"+cfg.host {
		return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update Host 或 Origin 无效", err)
	}
	for _, raw := range trusted {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil || !prefix.IsValid() || prefix != prefix.Masked() {
			return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update trusted proxy CIDR 无效", err)
		}
		cfg.trustedProxyCIDRs = append(cfg.trustedProxyCIDRs, prefix)
	}
	if strings.TrimSpace(cfg.channelKeyID) == "" ||
		strings.TrimSpace(cfg.computerArtifactBucket) == "" ||
		strings.TrimSpace(cfg.computerArtifactRegion) == "" {
		return computerUpdateServeConfig{}, apperror.New("CONFIG_INVALID", "Computer Update 服务参数不完整", nil)
	}
	return cfg, nil
}

func serveComputerUpdate(
	ctx context.Context,
	cfg computerUpdateServeConfig,
	stdout io.Writer,
) (returnErr error) {
	if ctx == nil {
		ctx = context.Background()
	}
	channelPrivateKey, err := loadChannelPrivateKey(cfg.channelPrivateKeyFile)
	if err != nil {
		return err
	}
	defer wipeBytes(channelPrivateKey)
	secretID, err := loadTextSecret(cfg.tencentCloudSecretIDFile, "腾讯云 SecretId")
	if err != nil {
		return err
	}
	secretKey, err := loadTextSecret(cfg.tencentCloudSecretKeyFile, "腾讯云 SecretKey")
	if err != nil {
		return err
	}
	securityToken := ""
	if cfg.tencentCloudTokenFile != "" {
		securityToken, err = loadTextSecret(cfg.tencentCloudTokenFile, "腾讯云 SecurityToken")
		if err != nil {
			return err
		}
	}
	signer, err := cosadapter.NewSigner(cosadapter.Config{
		Bucket: cfg.computerArtifactBucket, Region: cfg.computerArtifactRegion,
		SecretID: secretID, SecretKey: secretKey, SecurityToken: securityToken,
	})
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update COS 配置无效", err)
	}
	store, err := update.OpenStore(ctx, cfg.stateDirectory)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update 状态目录不可用", err)
	}
	defer func() {
		if closeErr := store.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("HTTP_SHUTDOWN_FAILED", "Computer Update 状态未能正常关闭", closeErr)
		}
	}()
	releases, err := update.NewFilesystemReleaseSource(cfg.releaseRoot, cfg.releasePublicKeyFile)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update Release 根目录无效", err)
	}
	ids := idport.UUIDv7{}
	service, err := update.NewService(update.ServiceConfig{
		Store: store, Releases: releases,
		ChannelKeyID: cfg.channelKeyID, ChannelPrivateKey: channelPrivateKey,
		URLs: signer, URLTTL: cfg.urlTTL, Clock: clockport.System{}, IDs: ids,
	})
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update service 配置无效", err)
	}
	handler, err := updatetransport.NewHandler(service)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update handler 配置无效", err)
	}
	routes, err := updatetransport.NewRoutes(handler, updatetransport.RoutesConfig{
		Host: cfg.host, Origin: cfg.origin, TrustedProxyCIDRs: cfg.trustedProxyCIDRs,
		RequestID: func() string {
			value, _ := ids.New()
			return value
		},
	})
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update routes 配置无效", err)
	}
	server, err := httptransport.NewServer(httptransport.ServerConfig{
		Address: cfg.listenAddress, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10,
		ShutdownTimeout: 15 * time.Second,
	}, routes)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "Computer Update HTTP Server 配置无效", err)
	}
	listener, err := net.Listen("tcp", cfg.listenAddress)
	if err != nil {
		return apperror.New("HTTP_LISTEN_FAILED", "Computer Update 无法监听 HTTP 地址", err)
	}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.HTTPServer().Serve(listener) }()
	fmt.Fprintf(stdout, "Computer Update 已启动：http://%s\n", listener.Addr().String())
	select {
	case serveErr := <-serveErrors:
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return apperror.New("HTTP_SERVE_FAILED", "Computer Update 服务异常退出", serveErr)
	case <-ctx.Done():
		shutdownErr := server.Shutdown(context.Background())
		serveErr := <-serveErrors
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		if shutdownErr != nil || serveErr != nil {
			return apperror.New(
				"HTTP_SHUTDOWN_FAILED",
				"Computer Update 服务未能正常停止",
				errors.Join(shutdownErr, serveErr),
			)
		}
		return nil
	}
}

func loadChannelPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := securefile.Read(path, "Computer Update Channel 私钥", 4096)
	if err != nil {
		return nil, err
	}
	encoded := strings.TrimSpace(string(data))
	for _, decoder := range []*base64.Encoding{
		base64.RawStdEncoding.Strict(), base64.StdEncoding.Strict(),
	} {
		key, decodeErr := decoder.DecodeString(encoded)
		if decodeErr == nil && len(key) == ed25519.PrivateKeySize {
			return ed25519.PrivateKey(key), nil
		}
	}
	return nil, apperror.New("CONFIG_INVALID", "Computer Update Channel 私钥必须是 64 字节 Base64", nil)
}

func wipeBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func writeComputerUpdateUsage(output io.Writer) {
	fmt.Fprintln(output, "用法：")
	fmt.Fprintln(output, "  chatserver computer-update serve --state-dir 绝对路径 --release-root 绝对路径 [安全配置]")
}
