// Package cli defines the public Vela Computer command surface.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"velachat/agent/internal/common"
)

var (
	ErrInvalidConfig    = errors.New("Vela CLI 配置无效")
	ErrInvalidArguments = errors.New("Vela CLI 参数无效")
)

type Command = cobra.Command

type StateOptions struct {
	StateDir string
}

type SetupOptions struct {
	StateOptions
	PlatformURL     string
	AccessTokenFile string
	ServerID        string
	Name            string
	Repair          bool
}

type DaemonRunOptions struct {
	StateOptions
}

type StatusOptions struct {
	StateOptions
	JSON bool
}

type TUIOptions struct {
	StateOptions
	PlatformURL string
}

type InstallOptions struct {
	PlatformURL               string
	AllowInsecurePlatformHTTP bool
	TokenFile                 string
	ManifestFile              string
	SignatureFile             string
	SigningPublicKey          string
	ReleaseVersion            string
	Target                    string
	ProgramFile               string
	InstallationRoot          string
	StateDirectory            string
}

type DoctorOptions struct {
	StateOptions
	JSON bool
}

type LogsOptions struct {
	StateOptions
	Follow bool
	Lines  int
}

type Actions interface {
	Install(context.Context, InstallOptions) error
	Setup(context.Context, SetupOptions) error
	DaemonRun(context.Context, DaemonRunOptions) error
	Status(context.Context, StatusOptions) error
	Doctor(context.Context, DoctorOptions) error
	Logs(context.Context, LogsOptions) error
	TUI(context.Context, TUIOptions) error
}

type RootConfig struct {
	Version               string
	Stdout                io.Writer
	Stderr                io.Writer
	Actions               Actions
	AllowInsecureLoopback bool
	AllowInsecureHTTP     bool
}

func NewRoot(config RootConfig) (*cobra.Command, error) {
	if strings.TrimSpace(config.Version) == "" ||
		config.Stdout == nil ||
		config.Stderr == nil ||
		config.Actions == nil {
		return nil, ErrInvalidConfig
	}
	root := &cobra.Command{
		Use:           "vela-computer",
		Short:         "Vela Computer 单机运行宿主",
		Long:          "Vela Computer 通过腾讯 TAT 接收机器控制，并通过腾讯云 IM 承载 Agent 实时聊天。",
		SilenceUsage:  true,
		SilenceErrors: true,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
	}
	root.SetOut(config.Stdout)
	root.SetErr(config.Stderr)
	root.AddCommand(
		newInstallCommand(config.Actions),
		newSetupCommand(
			config.Actions,
			config.AllowInsecureLoopback,
			config.AllowInsecureHTTP,
		),
		newDaemonCommand(config.Actions),
		newStatusCommand(config.Actions),
		newDoctorCommand(config.Actions),
		newLogsCommand(config.Actions),
		newTUICommand(
			config.Actions,
			config.AllowInsecureLoopback,
			config.AllowInsecureHTTP,
		),
		newVersionCommand(config.Version),
		&cobra.Command{
			Use:    "__agent-cli",
			Hidden: true,
			Args:   cobra.ArbitraryArgs,
		},
	)
	return root, nil
}

func newInstallCommand(actions Actions) *cobra.Command {
	options := InstallOptions{}
	command := &cobra.Command{
		Use:    "install",
		Short:  "验证发布并完成本机首次接入",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if options.ProgramFile == "" {
				program, err := os.Executable()
				if err != nil {
					return ErrInvalidArguments
				}
				options.ProgramFile = program
			}
			if options.InstallationRoot == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return ErrInvalidArguments
				}
				options.InstallationRoot = filepath.Join(home, ".vela", "computer")
			}
			for _, value := range []*string{
				&options.TokenFile,
				&options.ManifestFile,
				&options.SignatureFile,
				&options.ProgramFile,
				&options.InstallationRoot,
			} {
				if !filepath.IsAbs(*value) {
					return ErrInvalidArguments
				}
				*value = filepath.Clean(*value)
			}
			options.StateDirectory = filepath.Join(options.InstallationRoot, "state")
			return actions.Install(command.Context(), options)
		},
	}
	command.Flags().StringVar(&options.PlatformURL, "platform-url", "", "Chatserver 平台地址")
	command.Flags().BoolVar(
		&options.AllowInsecurePlatformHTTP,
		"allow-insecure-platform-http",
		false,
		"显式允许可信内网 HTTP 平台地址",
	)
	command.Flags().StringVar(&options.TokenFile, "token-file", "", "一次性接入凭证文件")
	command.Flags().StringVar(&options.ManifestFile, "manifest-file", "", "发布清单文件")
	command.Flags().StringVar(&options.SignatureFile, "signature-file", "", "发布签名文件")
	command.Flags().StringVar(&options.SigningPublicKey, "signing-public-key", "", "发布签名公钥")
	command.Flags().StringVar(&options.ReleaseVersion, "release-version", "", "固定发布版本")
	command.Flags().StringVar(&options.Target, "target", "", "固定发布 target")
	command.Flags().StringVar(&options.ProgramFile, "program-file", "", "待安装程序")
	command.Flags().StringVar(&options.InstallationRoot, "installation-root", "", "安装根目录")
	return command
}

func newTUICommand(
	actions Actions,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) *cobra.Command {
	options := TUIOptions{}
	command := &cobra.Command{
		Use:   "tui",
		Short: "打开 Human 与 Agent 协作终端",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateTUIPlatformURL(
				options.PlatformURL,
				allowInsecureLoopback,
				allowInsecureHTTP,
			); err != nil {
				return err
			}
			return actions.TUI(command.Context(), options)
		},
	}
	command.Flags().StringVar(&options.PlatformURL, "platform-url", "", "平台 HTTPS 地址")
	bindStateDir(command, &options.StateDir)
	return command
}

func newSetupCommand(
	actions Actions,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) *cobra.Command {
	options := SetupOptions{}
	command := &cobra.Command{
		Use:   "setup",
		Short: "将本机纳管为 Vela Computer",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateSetup(
				options,
				allowInsecureLoopback,
				allowInsecureHTTP,
			); err != nil {
				return err
			}
			return actions.Setup(command.Context(), options)
		},
	}
	command.Flags().StringVar(
		&options.PlatformURL,
		"platform-url",
		"",
		"平台 HTTPS 地址",
	)
	command.Flags().StringVar(
		&options.AccessTokenFile,
		"access-token-file",
		"",
		"Human access token 的绝对文件路径",
	)
	command.Flags().StringVar(
		&options.ServerID,
		"server-id",
		"",
		"要纳管到的 Server UUIDv7",
	)
	command.Flags().StringVar(&options.Name, "name", "", "Computer 名称")
	command.Flags().BoolVar(
		&options.Repair,
		"repair",
		false,
		"撤销旧 Computer credential 并恢复本机身份",
	)
	bindStateDir(command, &options.StateDir)
	return command
}

func newDaemonCommand(actions Actions) *cobra.Command {
	command := &cobra.Command{
		Use:   "daemon",
		Short: "管理 Vela Computer 守护进程",
		Args:  cobra.NoArgs,
	}
	command.AddCommand(newDaemonRunCommand(actions))
	return command
}

func newDaemonRunCommand(actions Actions) *cobra.Command {
	options := DaemonRunOptions{}
	command := &cobra.Command{
		Use:   "run",
		Short: "在前台持续运行 Vela Computer daemon",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return actions.DaemonRun(command.Context(), options)
		},
	}
	bindStateDir(command, &options.StateDir)
	return command
}

func newStatusCommand(actions Actions) *cobra.Command {
	options := StatusOptions{}
	command := &cobra.Command{
		Use:   "status",
		Short: "读取正在运行的 daemon 状态",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return actions.Status(command.Context(), options)
		},
	}
	command.Flags().BoolVar(&options.JSON, "json", false, "输出 JSON")
	bindStateDir(command, &options.StateDir)
	return command
}

func newDoctorCommand(actions Actions) *cobra.Command {
	options := DoctorOptions{}
	command := &cobra.Command{
		Use:   "doctor",
		Short: "通过 daemon 执行只读诊断",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return actions.Doctor(command.Context(), options)
		},
	}
	command.Flags().BoolVar(&options.JSON, "json", false, "输出 JSON")
	bindStateDir(command, &options.StateDir)
	return command
}

func newLogsCommand(actions Actions) *cobra.Command {
	options := LogsOptions{Lines: 200}
	command := &cobra.Command{
		Use:   "logs",
		Short: "读取 daemon 日志",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if options.Lines < 1 || options.Lines > 10000 {
				return ErrInvalidArguments
			}
			return actions.Logs(command.Context(), options)
		},
	}
	command.Flags().BoolVar(&options.Follow, "follow", false, "持续输出新日志")
	command.Flags().IntVar(&options.Lines, "lines", 200, "历史日志行数（1..10000）")
	bindStateDir(command, &options.StateDir)
	return command
}

func newVersionCommand(version string) *cobra.Command {
	asJSON := false
	command := &cobra.Command{
		Use:   "version",
		Short: "显示 Vela 客户端版本",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if !asJSON {
				_, err := fmt.Fprintf(
					command.OutOrStdout(),
					"vela-computer vela %s\n",
					version,
				)
				return err
			}
			encoded, err := common.Marshal(versionReport{
				Mode:    "vela",
				Name:    "vela-computer",
				Version: version,
			})
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(command.OutOrStdout(), "%s\n", encoded)
			return err
		},
	}
	command.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return command
}

func bindStateDir(command *cobra.Command, destination *string) {
	command.Flags().StringVar(
		destination,
		"state-dir",
		"",
		"Vela Computer 状态目录",
	)
}

func validateSetup(
	options SetupOptions,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) error {
	platformURL, err := url.Parse(strings.TrimSpace(options.PlatformURL))
	if err != nil ||
		!validSetupPlatformURL(
			platformURL,
			allowInsecureLoopback,
			allowInsecureHTTP,
		) ||
		!filepath.IsAbs(options.AccessTokenFile) ||
		!validUUIDv7(options.ServerID) ||
		utf8.RuneCountInString(options.Name) < 1 ||
		utf8.RuneCountInString(options.Name) > 100 {
		return ErrInvalidArguments
	}
	return nil
}

func validSetupPlatformURL(
	value *url.URL,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) bool {
	if value == nil || value.Host == "" {
		return false
	}
	if value.Scheme == "https" {
		return true
	}
	if value.Scheme != "http" {
		return false
	}
	if allowInsecureHTTP {
		return true
	}
	if !allowInsecureLoopback {
		return false
	}
	host := value.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func validateTUIPlatformURL(
	raw string,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) error {
	value, err := url.Parse(strings.TrimSpace(raw))
	if err == nil && validSetupPlatformURL(
		value,
		allowInsecureLoopback,
		allowInsecureHTTP,
	) {
		return nil
	}
	if err == nil && value != nil && value.Scheme == "http" && value.Host != "" {
		host := value.Hostname()
		address := net.ParseIP(host)
		if strings.EqualFold(host, "localhost") ||
			(address != nil && address.IsLoopback()) {
			return fmt.Errorf(
				"%w：本地 HTTP 默认禁用；开发环境请设置 VELA_ALLOW_INSECURE_LOOPBACK=1",
				ErrInvalidArguments,
			)
		}
		return fmt.Errorf(
			"%w：远程 HTTP 默认禁用；开发环境请设置 VELA_ALLOW_INSECURE_HTTP=1",
			ErrInvalidArguments,
		)
	}
	return fmt.Errorf(
		"%w：--platform-url 必须是有效的 HTTPS 地址",
		ErrInvalidArguments,
	)
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	return err == nil && parsed.Version() == 7
}

type versionReport struct {
	Mode    string `json:"mode"`
	Name    string `json:"name"`
	Version string `json:"version"`
}
