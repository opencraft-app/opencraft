package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	agentidentityadapter "chatserver/internal/adapters/agentidentity"
	agentpresenceadapter "chatserver/internal/adapters/agentpresence"
	credentialsadapter "chatserver/internal/adapters/credentials"
	imcommunityadapter "chatserver/internal/adapters/imcommunity"
	imdirectconversationadapter "chatserver/internal/adapters/imdirectconversation"
	imidentityadapter "chatserver/internal/adapters/imidentity"
	immembershipadapter "chatserver/internal/adapters/immembership"
	imtopicadapter "chatserver/internal/adapters/imtopic"
	reminderoccurrenceadapter "chatserver/internal/adapters/reminderoccurrence"
	tasknotificationadapter "chatserver/internal/adapters/tasknotification"
	cosadapter "chatserver/internal/adapters/tencent/cos"
	tatadapter "chatserver/internal/adapters/tencent/tat"
	tencentimadapter "chatserver/internal/adapters/tencentim"
	tencentoperationadapter "chatserver/internal/adapters/tencentoperation"
	appagentidentity "chatserver/internal/app/agentidentity"
	appagentpresence "chatserver/internal/app/agentpresence"
	appimcommunity "chatserver/internal/app/imcommunity"
	appimdirectconversation "chatserver/internal/app/imdirectconversation"
	appimidentity "chatserver/internal/app/imidentity"
	appimmembership "chatserver/internal/app/immembership"
	appimtopic "chatserver/internal/app/imtopic"
	appreminderoccurrence "chatserver/internal/app/reminderoccurrence"
	apptasknotification "chatserver/internal/app/tasknotification"
	apptencentoperation "chatserver/internal/app/tencentoperation"
	"chatserver/internal/apperror"
	"chatserver/internal/bootstrap"
	"chatserver/internal/computerrelease"
	"chatserver/internal/config"
	"chatserver/internal/database"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	tencenttatport "chatserver/internal/ports/tencenttat"
	"chatserver/internal/securefile"
	httptransport "chatserver/internal/transport/http"
	imidentityworker "chatserver/internal/worker/imidentity"
	reminderworker "chatserver/internal/worker/reminder"
)

const (
	defaultListenAddress        = "127.0.0.1:8080"
	defaultIMRESTBaseURL        = "https://console.tim.qq.com"
	productionTATRequestTimeout = 15 * time.Second
	productionTATLeaseTTL       = 90 * time.Second
)

type serveConfig struct {
	database                         config.Database
	databaseAutoMigrate              bool
	listenAddress                    string
	jwtKeyFile                       string
	allowedOrigins                   []string
	imSDKAppID                       int
	imAdminUserID                    string
	imSecretFile                     string
	imIdentityFile                   string
	imCallbackTokenFile              string
	imRESTBaseURL                    string
	computerInstallPublicURL         string
	allowInsecureComputerInstallHTTP bool
	tencentCloudSecretIDFile         string
	tencentCloudSecretKeyFile        string
	managedTATRegion                 string
	computerReleaseFile              string
	computerArtifactBucket           string
	computerArtifactRegion           string
}

type repeatedStrings []string

func (values *repeatedStrings) String() string {
	return strings.Join(*values, ",")
}

func (values *repeatedStrings) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("值不能为空")
	}
	*values = append(*values, value)
	return nil
}

func runServeCommand(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
) int {
	cfg, err := parseServeConfig(args)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	key, err := loadJWTKey(cfg.jwtKeyFile)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	imSecret, err := loadTextSecret(cfg.imSecretFile, "腾讯云 IM 密钥")
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	identityKey, err := loadIdentityKey(cfg.imIdentityFile)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	imCallbackToken := ""
	if cfg.imCallbackTokenFile != "" {
		imCallbackToken, err = loadTextSecret(
			cfg.imCallbackTokenFile,
			"腾讯云 IM 回调 Token",
		)
		if err != nil {
			writeCommandError(stderr, err)
			return exitCode(err)
		}
	}
	tencentCloudSecretID := ""
	tencentCloudSecretKey := ""
	if cfg.tencentCloudSecretIDFile != "" {
		tencentCloudSecretID, err = loadTextSecret(
			cfg.tencentCloudSecretIDFile,
			"腾讯云 SecretId",
		)
		if err != nil {
			writeCommandError(stderr, err)
			return exitCode(err)
		}
		tencentCloudSecretKey, err = loadTextSecret(
			cfg.tencentCloudSecretKeyFile,
			"腾讯云 SecretKey",
		)
		if err != nil {
			writeCommandError(stderr, err)
			return exitCode(err)
		}
	}
	if err := serveHumanPlatform(
		ctx,
		cfg,
		key,
		imSecret,
		identityKey,
		imCallbackToken,
		tencentCloudSecretID,
		tencentCloudSecretKey,
		stdout,
	); err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	return 0
}

func parseServeConfig(args []string) (serveConfig, error) {
	path, err := defaultDatabasePath()
	if err != nil {
		return serveConfig{}, err
	}
	var (
		databaseDriver                   = os.Getenv(databaseDriverEnvironment)
		databaseDSNFile                  = os.Getenv(databaseDSNFileEnvironment)
		maxOpenConnections               int
		maxIdleConnections               int
		connectionMaxLifetime            time.Duration
		databaseAutoMigrate              bool
		address                          string
		keyFile                          string
		origins                          repeatedStrings
		imSDKAppID                       int
		imAdminUserID                    string
		imSecretFile                     string
		imIdentityFile                   string
		imCallbackTokenFile              string
		imRESTBaseURL                    string
		computerInstallPublicURL         string
		allowInsecureComputerInstallHTTP bool
		tencentCloudSecretIDFile         string
		tencentCloudSecretKeyFile        string
		managedTATRegion                 string
		computerReleaseFile              string
		computerArtifactBucket           string
		computerArtifactRegion           string
	)
	if databaseDriver == "" {
		databaseDriver = string(config.DatabaseDriverSQLite)
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&databaseDriver, "database-driver", databaseDriver, "数据库方言：sqlite 或 tdsql")
	flags.StringVar(&path, "database", path, "SQLite 数据库绝对路径")
	flags.StringVar(&databaseDSNFile, "database-dsn-file", databaseDSNFile, "TDSQL DSN Secret 文件")
	flags.IntVar(&maxOpenConnections, "database-max-open-connections", 20, "MySQL 最大连接数")
	flags.IntVar(&maxIdleConnections, "database-max-idle-connections", 20, "MySQL 最大空闲连接数")
	flags.DurationVar(&connectionMaxLifetime, "database-connection-max-lifetime", 3*time.Minute, "MySQL 连接最长生命周期")
	flags.BoolVar(&databaseAutoMigrate, "database-auto-migrate", true, "服务启动时自动执行数据库迁移")
	flags.StringVar(&address, "listen", defaultListenAddress, "HTTP 监听地址")
	flags.StringVar(&keyFile, "jwt-key-file", "", "JWT HMAC 密钥文件")
	flags.IntVar(&imSDKAppID, "im-sdk-app-id", 0, "腾讯云 IM SDKAppID")
	flags.StringVar(
		&imAdminUserID,
		"im-admin-user-id",
		"",
		"腾讯云 IM 管理员 UserID",
	)
	flags.StringVar(
		&imSecretFile,
		"im-secret-key-file",
		"",
		"腾讯云 IM SecretKey 文件",
	)
	flags.StringVar(
		&imIdentityFile,
		"im-identity-key-file",
		"",
		"稳定 IM UserID 派生密钥文件",
	)
	flags.StringVar(
		&imCallbackTokenFile,
		"im-callback-token-file",
		"",
		"腾讯云 IM 状态回调 Token 文件（可选）",
	)
	flags.StringVar(
		&imRESTBaseURL,
		"im-rest-base-url",
		defaultIMRESTBaseURL,
		"腾讯云 IM REST API 基础 URL",
	)
	flags.StringVar(
		&computerInstallPublicURL,
		"computer-install-public-url",
		"",
		"Computer 一键安装入口地址",
	)
	flags.BoolVar(
		&allowInsecureComputerInstallHTTP,
		"allow-insecure-computer-install-http",
		false,
		"显式允许 Computer 一键安装入口使用可信内网 HTTP",
	)
	flags.StringVar(
		&tencentCloudSecretIDFile,
		"tencent-cloud-secret-id-file",
		"",
		"后台腾讯云 SecretId 文件",
	)
	flags.StringVar(
		&tencentCloudSecretKeyFile,
		"tencent-cloud-secret-key-file",
		"",
		"后台腾讯云 SecretKey 文件",
	)
	flags.StringVar(
		&managedTATRegion,
		"managed-tat-region",
		"ap-beijing",
		"外部托管 Computer 的腾讯云 TAT 注册地域",
	)
	flags.StringVar(
		&computerReleaseFile,
		"computer-release-file",
		"",
		"Computer 已批准不可变发布目录",
	)
	flags.StringVar(
		&computerArtifactBucket,
		"computer-artifact-bucket",
		"",
		"Computer 私有制品桶",
	)
	flags.StringVar(
		&computerArtifactRegion,
		"computer-artifact-region",
		"",
		"Computer 私有制品桶地域",
	)
	flags.Var(&origins, "cors-origin", "允许的浏览器 Origin，可重复")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return serveConfig{}, apperror.New("CONFIG_INVALID", "serve 参数无效", err)
	}
	var databaseConfig config.Database
	switch config.DatabaseDriver(strings.ToLower(strings.TrimSpace(databaseDriver))) {
	case config.DatabaseDriverSQLite:
		databaseConfig, err = config.NewDatabase(path)
	case config.DatabaseDriverTDSQL:
		databaseConfig, err = config.NewTDSQLDatabase(databaseDSNFile)
		if err == nil {
			databaseConfig.MaxOpenConnections = maxOpenConnections
			databaseConfig.MaxIdleConnections = maxIdleConnections
			databaseConfig.ConnectionMaxLifetime = connectionMaxLifetime
			err = databaseConfig.Validate()
		}
	default:
		err = apperror.New("CONFIG_INVALID", "数据库方言不受支持", nil)
	}
	if err != nil {
		return serveConfig{}, err
	}
	if err := validateListenAddress(address); err != nil {
		return serveConfig{}, apperror.New("CONFIG_INVALID", "监听地址无效", err)
	}
	if strings.TrimSpace(keyFile) == "" {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"必须提供 JWT 密钥文件",
			nil,
		)
	}
	if imSDKAppID <= 0 ||
		strings.TrimSpace(imAdminUserID) == "" ||
		strings.TrimSpace(imSecretFile) == "" ||
		strings.TrimSpace(imIdentityFile) == "" ||
		strings.TrimSpace(imRESTBaseURL) == "" ||
		strings.TrimSpace(computerInstallPublicURL) == "" {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"必须提供完整的腾讯云 IM 配置",
			nil,
		)
	}
	hasTencentCloudSecretID := strings.TrimSpace(tencentCloudSecretIDFile) != ""
	hasTencentCloudSecretKey := strings.TrimSpace(tencentCloudSecretKeyFile) != ""
	if hasTencentCloudSecretID != hasTencentCloudSecretKey {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"腾讯云 SecretId 和 SecretKey 文件必须同时提供",
			nil,
		)
	}
	if strings.TrimSpace(managedTATRegion) == "" {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"托管 TAT 地域不能为空",
			nil,
		)
	}
	computerReleaseFile = strings.TrimSpace(computerReleaseFile)
	computerArtifactBucket = strings.TrimSpace(computerArtifactBucket)
	computerArtifactRegion = strings.TrimSpace(computerArtifactRegion)
	computerArtifactConfigured := computerReleaseFile != "" ||
		computerArtifactBucket != "" || computerArtifactRegion != ""
	if computerArtifactConfigured && (computerReleaseFile == "" ||
		computerArtifactBucket == "" || computerArtifactRegion == "" ||
		!hasTencentCloudSecretID) {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"Computer 发布目录、私有桶和后台云凭据必须成组提供",
			nil,
		)
	}
	computerInstallPublicURL, err = normalizeComputerInstallPublicURL(
		computerInstallPublicURL,
		allowInsecureComputerInstallHTTP,
	)
	if err != nil {
		return serveConfig{}, apperror.New(
			"CONFIG_INVALID",
			"Computer 一键安装入口地址无效",
			err,
		)
	}
	return serveConfig{
		database:                         databaseConfig,
		databaseAutoMigrate:              databaseAutoMigrate,
		listenAddress:                    address,
		jwtKeyFile:                       keyFile,
		allowedOrigins:                   append([]string(nil), origins...),
		imSDKAppID:                       imSDKAppID,
		imAdminUserID:                    strings.TrimSpace(imAdminUserID),
		imSecretFile:                     imSecretFile,
		imIdentityFile:                   imIdentityFile,
		imCallbackTokenFile:              strings.TrimSpace(imCallbackTokenFile),
		imRESTBaseURL:                    strings.TrimSpace(imRESTBaseURL),
		computerInstallPublicURL:         computerInstallPublicURL,
		allowInsecureComputerInstallHTTP: allowInsecureComputerInstallHTTP,
		tencentCloudSecretIDFile:         strings.TrimSpace(tencentCloudSecretIDFile),
		tencentCloudSecretKeyFile:        strings.TrimSpace(tencentCloudSecretKeyFile),
		managedTATRegion:                 strings.TrimSpace(managedTATRegion),
		computerReleaseFile:              computerReleaseFile,
		computerArtifactBucket:           computerArtifactBucket,
		computerArtifactRegion:           computerArtifactRegion,
	}, nil
}

func normalizeComputerInstallPublicURL(value string, allowInsecureHTTP bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery ||
		(parsed.Path != "" && parsed.Path != "/") ||
		(parsed.RawPath != "" && parsed.RawPath != "/") ||
		strings.ContainsAny(value, "'\"$ \t\r\n\x00") {
		return "", errors.New("Computer 一键安装入口必须是安全 origin")
	}
	if parsed.Scheme == "https" {
		if allowInsecureHTTP {
			return "", errors.New("HTTP 许可与 HTTPS Computer 安装入口不一致")
		}
	} else if parsed.Scheme != "http" || !allowInsecureHTTP {
		return "", errors.New("远端 HTTP Computer 安装入口未显式许可")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed.String(), nil
}

func validateListenAddress(address string) error {
	host, rawPort, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil || strings.TrimSpace(host) == "" {
		return errors.New("监听地址必须包含主机和端口")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 0 || port > 65535 {
		return errors.New("监听端口无效")
	}
	return nil
}

func loadJWTKey(path string) ([]byte, error) {
	data, err := readSecureSecretFile(path, "JWT 密钥")
	if err != nil {
		return nil, err
	}
	encoded := strings.TrimSpace(string(data))
	decoders := []*base64.Encoding{
		base64.RawURLEncoding.Strict(),
		base64.URLEncoding.Strict(),
		base64.RawStdEncoding.Strict(),
		base64.StdEncoding.Strict(),
	}
	for _, decoder := range decoders {
		key, decodeErr := decoder.DecodeString(encoded)
		if decodeErr == nil && len(key) >= 32 {
			return key, nil
		}
	}
	return nil, apperror.New(
		"CONFIG_INVALID",
		"JWT 密钥必须是至少 32 字节的 Base64 数据",
		nil,
	)
}

func loadTextSecret(path string, label string) (string, error) {
	data, err := readSecureSecretFile(path, label)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if len(value) < 16 || len(value) > 4096 ||
		strings.ContainsAny(value, "\r\n\x00") {
		return "", apperror.New(
			"CONFIG_INVALID",
			label+"内容无效",
			nil,
		)
	}
	return value, nil
}

func loadIdentityKey(path string) ([]byte, error) {
	data, err := readSecureSecretFile(path, "IM 身份派生密钥")
	if err != nil {
		return nil, err
	}
	encoded := strings.TrimSpace(string(data))
	decoders := []*base64.Encoding{
		base64.RawURLEncoding.Strict(),
		base64.URLEncoding.Strict(),
		base64.RawStdEncoding.Strict(),
		base64.StdEncoding.Strict(),
	}
	for _, decoder := range decoders {
		key, decodeErr := decoder.DecodeString(encoded)
		if decodeErr == nil && len(key) == 32 {
			return key, nil
		}
	}
	return nil, apperror.New(
		"CONFIG_INVALID",
		"IM 身份派生密钥必须是 32 字节的 Base64 数据",
		nil,
	)
}

func readSecureSecretFile(path string, label string) ([]byte, error) {
	return securefile.Read(path, label, 4096)
}

func serveHumanPlatform(
	ctx context.Context,
	cfg serveConfig,
	accessTokenKey []byte,
	imSecret string,
	identityKey []byte,
	imCallbackToken string,
	tencentCloudSecretID string,
	tencentCloudSecretKey string,
	stdout io.Writer,
) (returnErr error) {
	if ctx == nil {
		ctx = context.Background()
	}
	adapter, err := database.AdapterFor(cfg.database.Driver)
	if err != nil {
		return err
	}
	handle, err := database.OpenWriter(ctx, cfg.database)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := handle.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("DATABASE_OPEN_FAILED", "关闭数据库连接失败", closeErr)
		}
	}()
	if cfg.databaseAutoMigrate {
		if err := adapter.Migrate(ctx, handle.SQLDB()); err != nil {
			return err
		}
	}
	status, err := adapter.MigrationStatus(ctx, handle.SQLDB())
	if err != nil {
		return err
	}
	if err := migrationStateError(status); err != nil {
		return err
	}
	if err := adapter.VerifySchema(ctx, handle.SQLDB()); err != nil {
		return err
	}
	clock := clockport.System{}
	var computerEnrollmentConfig *bootstrap.ComputerEnrollmentAPIConfig
	if cfg.computerReleaseFile != "" {
		release, err := computerrelease.LoadCatalog(cfg.computerReleaseFile)
		if err != nil {
			return apperror.New("CONFIG_INVALID", "Computer 发布目录无效", err)
		}
		signer, err := cosadapter.NewSigner(cosadapter.Config{
			Bucket: cfg.computerArtifactBucket, Region: cfg.computerArtifactRegion,
			SecretID: tencentCloudSecretID, SecretKey: tencentCloudSecretKey,
		})
		if err != nil {
			return apperror.New("CONFIG_INVALID", "Computer 私有制品下载配置无效", err)
		}
		computerEnrollmentConfig = &bootstrap.ComputerEnrollmentAPIConfig{
			Release: release, PlatformBaseURL: cfg.computerInstallPublicURL,
			AllowInsecureHTTP: cfg.allowInsecureComputerInstallHTTP,
			TokenTTL:          15 * time.Minute, CredentialTTL: 365 * 24 * time.Hour,
			ArtifactURLTTL: 5 * time.Minute, ArtifactSigner: signer,
		}
	}
	presenceRepository, err := agentpresenceadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Agent 在线投影", err)
	}
	presenceService, err := appagentpresence.NewService(presenceRepository)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Agent 在线投影", err)
	}
	userSigs, err := tencentimadapter.NewUserSigIssuer(
		cfg.imSDKAppID,
		imSecret,
		clock,
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "腾讯云 UserSig 配置无效", err)
	}
	provisioner, err := tencentimadapter.NewRESTIdentityProvisioner(
		tencentimadapter.RESTConfig{
			SDKAppID:        cfg.imSDKAppID,
			AdminUserID:     cfg.imAdminUserID,
			BaseURL:         cfg.imRESTBaseURL,
			HTTPClient:      &http.Client{Timeout: 15 * time.Second},
			Random:          rand.Reader,
			AdminSignatures: userSigs,
			AdminSigTTL:     10 * time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "腾讯云 IM REST 配置无效", err)
	}
	communityProvisioner, err := tencentimadapter.NewRESTCommunityProvisioner(
		tencentimadapter.RESTConfig{
			SDKAppID:        cfg.imSDKAppID,
			AdminUserID:     cfg.imAdminUserID,
			BaseURL:         cfg.imRESTBaseURL,
			HTTPClient:      &http.Client{Timeout: 15 * time.Second},
			Random:          rand.Reader,
			AdminSignatures: userSigs,
			AdminSigTTL:     10 * time.Minute,
		},
	)
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"腾讯云 IM Community 配置无效",
			err,
		)
	}
	deriver, err := tencentimadapter.NewIdentityDeriver(identityKey)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "IM 身份派生配置无效", err)
	}
	workRepository, err := imidentityadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 IM Worker", err)
	}
	workerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 IM Worker 身份", err)
	}
	workService, err := appimidentity.NewService(
		workRepository,
		deriver,
		provisioner,
		clock,
		appimidentity.Config{
			WorkerID:    workerID,
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 8,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 IM Worker", err)
	}
	worker, err := imidentityworker.New(
		workService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 IM Worker", err)
	}
	agentIdentityRepository, err := agentidentityadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Agent IM Worker", err)
	}
	agentIdentityWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Agent IM Worker 身份", err)
	}
	agentIdentityService, err := appagentidentity.NewService(
		agentIdentityRepository,
		provisioner,
		idport.UUIDv7{},
		clock,
		appagentidentity.Config{
			WorkerID:    agentIdentityWorkerID,
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 8,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Agent IM Worker", err)
	}
	repairedMemberships, err := agentIdentityService.RepairLegacyMemberships(
		ctx,
	)
	if err != nil {
		return apperror.New(
			"DATABASE_MIGRATION_FAILED",
			"无法修复旧 Agent Community 成员关系",
			err,
		)
	}
	if repairedMemberships > 0 {
		fmt.Fprintf(
			stdout,
			"已调度 %d 个旧 Agent Community 成员修复\n",
			repairedMemberships,
		)
	}
	agentIdentityWorker, err := imidentityworker.New(
		agentIdentityService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Agent IM Worker", err)
	}
	communityRepository, err := imcommunityadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Community Worker", err)
	}
	communityWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Community Worker 身份", err)
	}
	communityService, err := appimcommunity.NewService(
		communityRepository,
		communityProvisioner,
		clock,
		appimcommunity.Config{
			WorkerID:    communityWorkerID,
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 8,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Community Worker", err)
	}
	communityWorker, err := imidentityworker.New(
		communityService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Community Worker", err)
	}
	topicRepository, err := imtopicadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Topic Worker", err)
	}
	resourceDeriver, err := tencentimadapter.NewResourceDeriver(identityKey)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "IM 资源派生配置无效", err)
	}
	repairedSystemTopics, err := topicRepository.RepairLegacySystemTopics(
		ctx,
		resourceDeriver,
		idport.UUIDv7{},
		clock.Now().UTC(),
	)
	if err != nil {
		return apperror.New(
			"DATABASE_MIGRATION_FAILED",
			"无法修复旧 Server 的全员系统 Topic",
			err,
		)
	}
	if repairedSystemTopics > 0 {
		fmt.Fprintf(
			stdout,
			"已调度 %d 个旧 Server 全员系统 Topic 修复\n",
			repairedSystemTopics,
		)
	}
	topicWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Topic Worker 身份", err)
	}
	topicService, err := appimtopic.NewService(
		topicRepository,
		communityProvisioner,
		clock,
		appimtopic.Config{
			WorkerID:    topicWorkerID,
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 8,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Topic Worker", err)
	}
	topicWorker, err := imidentityworker.New(
		topicService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Topic Worker", err)
	}
	directIMRepository, err := imdirectconversationadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Server 内私信 IM Worker", err)
	}
	directIMWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Server 内私信 IM Worker 身份", err)
	}
	directIMService, err := appimdirectconversation.NewService(
		directIMRepository,
		communityProvisioner,
		clock,
		appimdirectconversation.Config{
			WorkerID: directIMWorkerID, LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Server 内私信 IM Worker", err)
	}
	directIMWorker, err := imidentityworker.New(
		directIMService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Server 内私信 IM Worker", err)
	}
	membershipRepository, err := immembershipadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"无法组装 IM membership Worker",
			err,
		)
	}
	membershipWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"无法创建 IM membership Worker 身份",
			err,
		)
	}
	membershipService, err := appimmembership.NewService(
		membershipRepository,
		communityProvisioner,
		clock,
		appimmembership.Config{
			WorkerID:    membershipWorkerID,
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 8,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"无法组装 IM membership Worker",
			err,
		)
	}
	membershipWorker, err := imidentityworker.New(
		membershipService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"无法组装 IM membership Worker",
			err,
		)
	}
	var tatClient *tatadapter.Client
	var terminalIssuer tencenttatport.TerminalSessionIssuer
	if tencentCloudSecretID != "" {
		tatClient, err = tatadapter.NewCredentialClient(
			tencentCloudSecretID,
			tencentCloudSecretKey,
			productionTATRequestTimeout,
		)
		if err == nil {
			terminalIssuer, err = tatadapter.NewCredentialCloudSessionIssuer(
				tencentCloudSecretID,
				tencentCloudSecretKey,
				productionTATRequestTimeout,
			)
		}
	} else {
		tatClient, err = tatadapter.NewDefaultClient(productionTATRequestTimeout)
		if err == nil {
			terminalIssuer, err = tatadapter.NewDefaultCloudSessionIssuer(
				productionTATRequestTimeout,
			)
		}
	}
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装腾讯云 TAT/PTY Client", err)
	}
	tatRepository, err := tencentoperationadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 TAT Worker", err)
	}
	tatWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 TAT Worker 身份", err)
	}
	tatService, err := apptencentoperation.NewComputerService(
		tatRepository,
		tatClient,
		clock,
		productionTATWorkerConfig(tatWorkerID),
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 TAT Worker", err)
	}
	tatWorker, err := imidentityworker.New(
		tatService,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 TAT Worker", err)
	}
	reminderRepository, err := reminderoccurrenceadapter.NewEntRepository(
		handle,
		idport.UUIDv7{},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Reminder Worker", err)
	}
	reminderNotificationSender, err := tencentimadapter.NewRESTAgentNotificationSender(
		tencentimadapter.RESTConfig{
			SDKAppID:        cfg.imSDKAppID,
			AdminUserID:     cfg.imAdminUserID,
			BaseURL:         cfg.imRESTBaseURL,
			HTTPClient:      &http.Client{Timeout: 15 * time.Second},
			Random:          rand.Reader,
			AdminSignatures: userSigs,
			AdminSigTTL:     10 * time.Minute,
		},
	)
	if err != nil {
		return apperror.New(
			"CONFIG_INVALID",
			"腾讯云 IM Reminder 通知配置无效",
			err,
		)
	}
	reminderWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Reminder Worker 身份", err)
	}
	reminderService, err := appreminderoccurrence.NewSchedulerService(
		reminderRepository,
		reminderNotificationSender,
		clock,
		appreminderoccurrence.SchedulerConfig{
			WorkerID: reminderWorkerID, LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Reminder Worker", err)
	}
	reminderWorker, err := reminderworker.New(
		reminderService,
		reminderworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Reminder Worker", err)
	}
	taskNotificationRepository, err := tasknotificationadapter.NewEntRepository(handle)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Task notification Worker", err)
	}
	taskNotificationWorkerID, err := idport.UUIDv7{}.New()
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法创建 Task notification Worker 身份", err)
	}
	taskNotificationProcessor, err := apptasknotification.NewProcessor(
		taskNotificationRepository,
		reminderNotificationSender,
		clock,
		apptasknotification.Config{
			WorkerID: taskNotificationWorkerID, LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Task notification Worker", err)
	}
	taskNotificationWorker, err := reminderworker.New(
		taskNotificationProcessor,
		reminderworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Task notification Worker", err)
	}
	platformHandler, err := bootstrap.NewPlatformAPIHandler(bootstrap.PlatformAPIConfig{
		Human: bootstrap.HumanAPIConfig{
			Auth: bootstrap.AuthAPIConfig{
				Database:       handle,
				AccessTokenKey: accessTokenKey,
				Password:       credentialsadapter.ProductionArgon2idConfig(),
				AccessTTL:      15 * time.Minute,
				RefreshTTL:     30 * 24 * time.Hour,
				RequestTimeout: 30 * time.Second,
				MaxBodyBytes:   16 * 1024,
				AllowedOrigins: cfg.allowedOrigins,
			},
			SDKAppID:      cfg.imSDKAppID,
			UserSigTTL:    time.Hour,
			UserSigIssuer: userSigs,
		},
		IMResourceKey:      identityKey,
		ServerCreationWait: 10 * time.Second,
		TATRegistrar:       tatClient,
		TerminalIssuer:     terminalIssuer,
		ManagedTATRegion:   cfg.managedTATRegion,
		ComputerEnrollment: computerEnrollmentConfig,
	})
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装平台 API", err)
	}
	runtimeHandler, err := bootstrap.NewRuntimeAPIHandler(
		bootstrap.RuntimeAPIConfig{
			Database:       handle,
			AccessTokenKey: accessTokenKey,
			AccessTTL:      15 * time.Minute,
			SDKAppID:       cfg.imSDKAppID,
			UserSigTTL:     time.Hour,
			UserSigIssuer:  userSigs,
			RequestTimeout: 30 * time.Second,
			MaxBodyBytes:   16 * 1024,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Runtime API", err)
	}
	computerHandler, err := bootstrap.NewComputerAPIHandler(
		bootstrap.ComputerAPIConfig{
			Database:       handle,
			AccessTokenKey: accessTokenKey,
			AccessTTL:      15 * time.Minute,
			SDKAppID:       cfg.imSDKAppID,
			UserSigTTL:     time.Hour,
			UserSigIssuer:  userSigs,
			RequestTimeout: 30 * time.Second,
			MaxBodyBytes:   16 * 1024,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Computer 控制 API", err)
	}
	bootstrapEncryptionKey := sha256.Sum256(append(
		[]byte("agent-network-computer-bootstrap-v1\x00"),
		accessTokenKey...,
	))
	computerBootstrapAPI, err := bootstrap.NewComputerBootstrapAPI(
		bootstrap.ComputerBootstrapAPIConfig{
			Database: handle, Registrar: tatClient, Region: cfg.managedTATRegion,
			EncryptionKey: bootstrapEncryptionKey[:], Random: rand.Reader,
			RequestTimeout: 15 * time.Second, MaxBodyBytes: 4 * 1024,
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Computer bootstrap API", err)
	}
	computerBootstrapWorker, err := imidentityworker.New(
		computerBootstrapAPI.Processor,
		imidentityworker.Config{PollInterval: 500 * time.Millisecond},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装 Computer bootstrap Worker", err)
	}
	rootHandler := http.NewServeMux()
	readinessHandler, err := httptransport.NewReadinessHandler(
		func(requestContext context.Context) error {
			return handle.SQLDB().PingContext(requestContext)
		},
	)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "无法组装就绪检查", err)
	}
	rootHandler.Handle("/healthz", httptransport.NewLivenessHandler())
	rootHandler.Handle("/readyz", readinessHandler)
	if imCallbackToken != "" {
		callbackHandler, err := httptransport.NewTencentIMStateCallbackHandler(
			httptransport.TencentIMStateCallbackConfig{
				SDKAppID:     int64(cfg.imSDKAppID),
				Token:        []byte(imCallbackToken),
				Clock:        clock,
				MaxBodyBytes: 16 << 10,
			},
			presenceService,
		)
		if err != nil {
			return apperror.New(
				"CONFIG_INVALID",
				"腾讯云 IM 状态回调配置无效",
				err,
			)
		}
		rootHandler.Handle("/v1/callbacks/tencent-im/state", callbackHandler)
	}
	rootHandler.Handle("/v1/runtime/", runtimeHandler)
	rootHandler.Handle("/v1/bootstrap/", computerBootstrapAPI.Handler)
	// Enrollment claim and short-code redemption are public bootstrap operations.
	// Keep their exact routes on the Platform handler so the broader authenticated
	// Computer control prefix cannot shadow them.
	rootHandler.Handle("/v1/computer/enrollments:claim", platformHandler)
	rootHandler.Handle("/v1/computer/setup-codes:redeem", platformHandler)
	rootHandler.Handle("/v1/computer/", computerHandler)
	rootHandler.Handle("/v1", platformHandler)
	rootHandler.Handle("/v1/", platformHandler)
	if computerEnrollmentConfig != nil {
		installHandler, err := httptransport.NewComputerInstallHandler(
			httptransport.ComputerInstallHandlerConfig{
				BaseURL:           cfg.computerInstallPublicURL,
				AllowInsecureHTTP: cfg.allowInsecureComputerInstallHTTP,
			},
		)
		if err != nil {
			return apperror.New("CONFIG_INVALID", "无法组装 Computer 安装入口", err)
		}
		rootHandler.Handle("/install", installHandler)
	}
	server, err := httptransport.NewServer(httptransport.ServerConfig{
		Address:           cfg.listenAddress,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
		ShutdownTimeout:   15 * time.Second,
	}, rootHandler)
	if err != nil {
		return apperror.New("CONFIG_INVALID", "HTTP Server 配置无效", err)
	}
	listener, err := net.Listen("tcp", cfg.listenAddress)
	if err != nil {
		return apperror.New("HTTP_LISTEN_FAILED", "无法监听 HTTP 地址", err)
	}

	runContext, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.HTTPServer().Serve(listener)
	}()
	workers := []interface {
		Run(context.Context) error
	}{
		worker,
		agentIdentityWorker,
		communityWorker,
		topicWorker,
		directIMWorker,
		membershipWorker,
		tatWorker,
		computerBootstrapWorker,
		reminderWorker,
		taskNotificationWorker,
	}
	workerErrors := make(chan error, len(workers))
	for _, currentWorker := range workers {
		go func(current interface {
			Run(context.Context) error
		}) {
			workerErrors <- current.Run(runContext)
		}(currentWorker)
	}
	fmt.Fprintf(
		stdout,
		"平台 API 与 IM Worker 已启动：http://%s\n",
		listener.Addr().String(),
	)

	select {
	case err := <-serveErrors:
		cancelRun()
		workerErr := collectWorkerErrors(workerErrors, len(workers))
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		if err != nil || workerErr != nil {
			return apperror.New(
				"HTTP_SERVE_FAILED",
				"平台服务异常退出",
				errors.Join(err, workerErr),
			)
		}
		return nil
	case workerErr := <-workerErrors:
		cancelRun()
		shutdownErr := server.Shutdown(context.Background())
		serveErr := <-serveErrors
		workerErr = errors.Join(
			workerErr,
			collectWorkerErrors(workerErrors, len(workers)-1),
		)
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		if workerErr != nil || shutdownErr != nil || serveErr != nil {
			return apperror.New(
				"HTTP_SERVE_FAILED",
				"IM Worker 异常退出",
				errors.Join(workerErr, shutdownErr, serveErr),
			)
		}
		return nil
	case <-ctx.Done():
		cancelRun()
		shutdownErr := server.Shutdown(context.Background())
		serveErr := <-serveErrors
		workerErr := collectWorkerErrors(workerErrors, len(workers))
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		if shutdownErr != nil || serveErr != nil || workerErr != nil {
			return apperror.New(
				"HTTP_SHUTDOWN_FAILED",
				"平台服务未能正常停止",
				errors.Join(shutdownErr, serveErr, workerErr),
			)
		}
		return nil
	}
}

func productionTATWorkerConfig(workerID string) apptencentoperation.Config {
	return apptencentoperation.Config{
		WorkerID:    workerID,
		LeaseTTL:    productionTATLeaseTTL,
		MaxAttempts: 8,
		BaseBackoff: time.Second,
		MaxBackoff:  time.Minute,
		PollDelay:   2 * time.Second,
	}
}

func collectWorkerErrors(channel <-chan error, count int) error {
	values := make([]error, 0, count)
	for range count {
		values = append(values, <-channel)
	}
	return errors.Join(values...)
}
