package clientcli

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

type Dependencies struct {
	Out        io.Writer
	Err        io.Writer
	HTTPClient *http.Client
}

type rootOptions struct {
	controlURL    string
	trafficURL    string
	internalToken string
	adminToken    string
	apiKey        string
	timeout       time.Duration
	output        string
	verbose       bool
	dryRun        bool
	deps          Dependencies
}

func NewRoot(deps Dependencies) *cobra.Command {
	if deps.Out == nil {
		deps.Out = os.Stdout
	}
	if deps.Err == nil {
		deps.Err = os.Stderr
	}
	opts := &rootOptions{timeout: 30 * time.Second, output: "table", deps: deps}
	root := &cobra.Command{
		Use:           "velagw",
		Short:         "从甲方视角验收 LLMGateway",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetOut(deps.Out)
	root.SetErr(deps.Err)
	flags := root.PersistentFlags()
	flags.StringVar(&opts.controlURL, "control-url", "", "LLMGateway 管理面地址")
	flags.StringVar(&opts.trafficURL, "traffic-url", "", "LLMGateway 流量面地址")
	flags.StringVar(&opts.internalToken, "internal-token", "", "trade/ctl 服务间 token")
	flags.StringVar(&opts.adminToken, "admin-token", "", "运营管理 token")
	flags.StringVar(&opts.apiKey, "api-key", "", "终端 Agent 的 sk-... 模型密钥")
	flags.DurationVar(&opts.timeout, "timeout", opts.timeout, "单次 HTTP 请求超时")
	flags.StringVarP(&opts.output, "output", "o", opts.output, "输出格式：table 或 json")
	flags.BoolVar(&opts.verbose, "verbose", false, "输出脱敏请求轨迹")
	flags.BoolVar(&opts.dryRun, "dry-run", false, "只展示调用计划，不发送请求")

	root.AddCommand(
		newDoctorCommand(opts),
		newCtlCommand(opts),
		newAdminCommand(opts),
		newTrafficCommand(opts),
		newScenarioCommand(opts),
	)
	return root
}

func (o *rootOptions) client() (*client.Client, error) {
	format := strings.ToLower(strings.TrimSpace(o.output))
	if format != "table" && format != "json" {
		return nil, fmt.Errorf("--output 只支持 table 或 json")
	}
	return client.New(client.Config{
		ControlURL:    o.controlURL,
		TrafficURL:    o.trafficURL,
		InternalToken: o.internalToken,
		AdminToken:    o.adminToken,
		APIKey:        o.apiKey,
		Timeout:       o.timeout,
		DryRun:        o.dryRun,
		HTTPClient:    o.deps.HTTPClient,
		Trace:         o.trace,
	})
}

func (o *rootOptions) renderer() ui.Renderer {
	return ui.Renderer{Writer: o.deps.Out, Format: o.output}
}

func (o *rootOptions) trace(trace client.Trace) {
	if !o.verbose || o.deps.Err == nil {
		return
	}
	status := "-"
	if trace.StatusCode > 0 {
		status = fmt.Sprintf("%d", trace.StatusCode)
	}
	_, _ = fmt.Fprintf(o.deps.Err, "[%s] %s %s status=%s duration=%s dry_run=%v\n",
		trace.Lane, trace.Method, trace.Path, status, trace.Duration.Round(time.Millisecond), trace.DryRun)
}

func splitCommandPath(path string) []string {
	return strings.Fields(path)
}

func requireValues(values map[string]string) error {
	missing := make([]string, 0)
	for name, value := range values {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf("缺少必要参数：%s", strings.Join(missing, "、"))
}
