package clientcli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newCtlBYOKCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "byok", Short: "维护用户自带模型渠道"}
	get := &byokUserOptions{label: "读取 BYOK 设置"}
	getCommand := leafCommand("get", "读取用户 BYOK 设置", root, get)
	getCommand.Flags().StringVar(&get.userID, "user-id", "", "业务用户 ID")
	set := &byokSetOptions{mode: "byok_first"}
	setCommand := leafCommand("set", "保存用户 BYOK 设置", root, set)
	setCommand.Flags().StringVar(&set.userID, "user-id", "", "业务用户 ID")
	setCommand.Flags().StringVar(&set.mode, "mode", set.mode, "路由策略：byok_first 或 platform_first")
	setCommand.Flags().StringArrayVar(&set.providerJSON, "provider", nil, "渠道 JSON；可重复传入，API Key 仅发送给控制面")
	syncOptions := &byokUserOptions{sync: true, label: "提交 BYOK 同步"}
	syncCommand := leafCommand("sync", "提交异步同步任务", root, syncOptions)
	syncCommand.Flags().StringVar(&syncOptions.userID, "user-id", "", "业务用户 ID")
	command.AddCommand(getCommand, setCommand, syncCommand)
	return command
}

type byokUserOptions struct {
	userID string
	sync   bool
	label  string
}

func (o *byokUserOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *byokUserOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	var result client.Result
	var err error
	if o.sync {
		result, err = api.SyncBYOK(ctx, o.userID)
	} else {
		result, err = api.GetBYOK(ctx, o.userID)
	}
	if err != nil {
		return err
	}
	return renderer.Print(o.label, result)
}

type byokSetOptions struct {
	userID       string
	mode         string
	providerJSON []string
	providers    []client.BYOKProviderInput
}

func (o *byokSetOptions) Validate() error {
	if err := requireValues(map[string]string{"--user-id": o.userID}); err != nil {
		return err
	}
	o.mode = strings.ToLower(strings.TrimSpace(o.mode))
	if o.mode != "byok_first" && o.mode != "platform_first" {
		return fmt.Errorf("--mode 只支持 byok_first 或 platform_first")
	}
	if len(o.providerJSON) == 0 {
		return fmt.Errorf("至少需要一个 --provider")
	}
	o.providers = make([]client.BYOKProviderInput, 0, len(o.providerJSON))
	for index, raw := range o.providerJSON {
		var provider client.BYOKProviderInput
		if err := json.Unmarshal([]byte(raw), &provider); err != nil {
			return fmt.Errorf("第 %d 个 --provider 不是合法 JSON: %w", index+1, err)
		}
		var fields map[string]json.RawMessage
		_ = json.Unmarshal([]byte(raw), &fields)
		if _, exists := fields["enabled"]; !exists {
			provider.Enabled = true
		}
		if err := requireValues(map[string]string{
			"provider.id": provider.ID, "provider.name": provider.Name, "provider.protocol": provider.Protocol,
			"provider.base_url": provider.BaseURL, "provider.api_key": provider.APIKey,
		}); err != nil {
			return fmt.Errorf("第 %d 个 --provider: %w", index+1, err)
		}
		switch strings.ToLower(strings.TrimSpace(provider.Protocol)) {
		case "openai", "openai-compatible", "openai_compatible":
			provider.Protocol = "openai_compatible"
		case "anthropic":
			provider.Protocol = "anthropic"
		default:
			return fmt.Errorf("第 %d 个 --provider: protocol 只支持 openai 或 anthropic", index+1)
		}
		o.providers = append(o.providers, provider)
	}
	return nil
}

func (o *byokSetOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	input := client.BYOKSettingsInput{Routing: client.BYOKRoutingInput{Mode: o.mode}, Providers: o.providers}
	result, err := api.SetBYOK(ctx, o.userID, input)
	if err != nil {
		return err
	}
	return renderer.Print("保存 BYOK 设置", result)
}
