package clientcli

import (
	"context"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	clientscenario "git.woa.com/wisp/mono2/llmgateway/internal/clientcli/scenario"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newScenarioCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "scenario", Short: "按真实业务顺序执行一组验收动作"}
	command.AddCommand(
		newTradeLifecycleCommand(root),
		newOnboardScenarioCommand(root),
		newRenewScenarioCommand(root),
		newCancelScenarioCommand(root),
		newBYOKScenarioCommand(root),
		newFullScenarioCommand(root),
	)
	return command
}

type tradeLifecycleOptions struct {
	apply subscriptionApplyOptions
}

func newTradeLifecycleCommand(root *rootOptions) *cobra.Command {
	options := &tradeLifecycleOptions{}
	command := leafCommand("trade-lifecycle", "完整验证开通、查询和取消", root, options)
	bindApplyFlags(command, &options.apply)
	return command
}

func (o *tradeLifecycleOptions) Validate() error {
	return o.apply.Validate()
}

func (o *tradeLifecycleOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	report, err := (clientscenario.Runner{Gateway: api}).TradeLifecycle(ctx, clientscenario.TradeLifecycleInput{
		UserID: o.apply.userID, Nickname: o.apply.nickname, PlanID: o.apply.planID,
		IdempotencyKey: o.apply.idempotencyKey, PeriodValue: o.apply.periodValue,
		PeriodUnit: o.apply.periodUnit,
	})
	return renderScenario(renderer, report, err)
}

type onboardScenarioOptions struct {
	apply   subscriptionApplyOptions
	keyName string
}

func newOnboardScenarioCommand(root *rootOptions) *cobra.Command {
	options := &onboardScenarioOptions{keyName: "default"}
	command := leafCommand("onboard", "创建租户、开通订阅并签发模型 Key", root, options)
	bindApplyFlags(command, &options.apply)
	command.Flags().StringVar(&options.keyName, "key-name", options.keyName, "新模型 Key 的名称")
	return command
}

func (o *onboardScenarioOptions) Validate() error { return o.apply.Validate() }

func (o *onboardScenarioOptions) input() clientscenario.OnboardInput {
	return clientscenario.OnboardInput{
		UserID: o.apply.userID, Nickname: o.apply.nickname, Phone: o.apply.phone,
		PlanID: o.apply.planID, IdempotencyKey: o.apply.idempotencyKey,
		PeriodValue: o.apply.periodValue, PeriodUnit: o.apply.periodUnit, KeyName: o.keyName,
	}
}

func (o *onboardScenarioOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	report, err := (clientscenario.Runner{Gateway: api}).Onboard(ctx, o.input())
	return renderScenario(renderer, report, err)
}

type renewScenarioOptions struct {
	apply subscriptionApplyOptions
}

func newRenewScenarioCommand(root *rootOptions) *cobra.Command {
	options := &renewScenarioOptions{}
	command := leafCommand("renew", "模拟一笔续费订单并确认权益", root, options)
	bindApplyFlags(command, &options.apply)
	return command
}

func (o *renewScenarioOptions) Validate() error { return o.apply.Validate() }

func (o *renewScenarioOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	report, err := (clientscenario.Runner{Gateway: api}).Renew(ctx, clientscenario.RenewInput{
		Apply: o.apply.input(),
	})
	return renderScenario(renderer, report, err)
}

type cancelScenarioOptions struct{ userID string }

func newCancelScenarioCommand(root *rootOptions) *cobra.Command {
	options := &cancelScenarioOptions{}
	command := leafCommand("cancel", "取消订阅并验证结果", root, options)
	command.Flags().StringVar(&options.userID, "user-id", "", "业务用户 ID")
	return command
}

func (o *cancelScenarioOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *cancelScenarioOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	report, err := (clientscenario.Runner{Gateway: api}).Cancel(ctx, o.userID)
	return renderScenario(renderer, report, err)
}

type byokScenarioOptions struct{ settings byokSetOptions }

func newBYOKScenarioCommand(root *rootOptions) *cobra.Command {
	options := &byokScenarioOptions{settings: byokSetOptions{mode: "byok_first"}}
	command := leafCommand("byok", "保存、同步并读取用户 BYOK 设置", root, options)
	bindBYOKFlags(command, &options.settings)
	return command
}

func (o *byokScenarioOptions) Validate() error { return o.settings.Validate() }

func (o *byokScenarioOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	report, err := (clientscenario.Runner{Gateway: api}).BYOK(ctx, clientscenario.BYOKInput{
		UserID: o.settings.userID,
		Settings: client.BYOKSettingsInput{
			Routing: client.BYOKRoutingInput{Mode: o.settings.mode}, Providers: o.settings.providers,
		},
	})
	return renderScenario(renderer, report, err)
}

type fullScenarioOptions struct {
	onboard onboardScenarioOptions
	byok    byokSetOptions
	chat    trafficChatOptions
}

func newFullScenarioCommand(root *rootOptions) *cobra.Command {
	options := &fullScenarioOptions{
		onboard: onboardScenarioOptions{keyName: "default"},
		byok:    byokSetOptions{mode: "byok_first"},
		chat:    trafficChatOptions{model: "auto", prompt: "你好"},
	}
	command := leafCommand("full", "跨管理面和流量面执行完整甲方验收", root, options)
	bindApplyFlags(command, &options.onboard.apply)
	command.Flags().StringVar(&options.onboard.keyName, "key-name", options.onboard.keyName, "新模型 Key 的名称")
	command.Flags().StringVar(&options.byok.mode, "byok-mode", options.byok.mode, "BYOK 路由策略")
	command.Flags().StringArrayVar(&options.byok.providerJSON, "provider", nil, "BYOK 渠道 JSON；可重复传入")
	command.Flags().StringVar(&options.chat.model, "model", options.chat.model, "模型或虚拟模型 ID")
	command.Flags().StringVar(&options.chat.prompt, "prompt", options.chat.prompt, "用户消息")
	command.Flags().StringVar(&options.chat.system, "system", "", "系统消息")
	command.Flags().BoolVar(&options.chat.stream, "stream", false, "使用流式响应")
	return command
}

func (o *fullScenarioOptions) Validate() error {
	if err := o.onboard.Validate(); err != nil {
		return err
	}
	o.byok.userID = o.onboard.apply.userID
	if err := o.byok.Validate(); err != nil {
		return err
	}
	return o.chat.Validate()
}

func (o *fullScenarioOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	runner := clientscenario.Runner{Gateway: api, TrafficForKey: func(key string) clientscenario.TrafficGateway {
		return api.WithAPIKey(key)
	}}
	report, err := runner.Full(ctx, clientscenario.FullInput{
		Onboard: o.onboard.input(),
		BYOK: clientscenario.BYOKInput{
			UserID: o.byok.userID,
			Settings: client.BYOKSettingsInput{
				Routing: client.BYOKRoutingInput{Mode: o.byok.mode}, Providers: o.byok.providers,
			},
		},
		Chat: client.ChatInput{Model: o.chat.model, Prompt: o.chat.prompt, System: o.chat.system, Stream: o.chat.stream},
	})
	return renderScenario(renderer, report, err)
}

func bindBYOKFlags(command *cobra.Command, options *byokSetOptions) {
	command.Flags().StringVar(&options.userID, "user-id", "", "业务用户 ID")
	command.Flags().StringVar(&options.mode, "mode", options.mode, "路由策略：byok_first 或 platform_first")
	command.Flags().StringArrayVar(&options.providerJSON, "provider", nil, "渠道 JSON；可重复传入")
}

func renderScenario(renderer ui.Renderer, report clientscenario.Report, scenarioErr error) error {
	if err := renderer.PrintScenario(report); err != nil {
		return err
	}
	return scenarioErr
}
