package clientcli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newCtlSubscriptionCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "subscription", Short: "模拟订阅开通、续期和取消"}
	apply := &subscriptionApplyOptions{}
	applyCommand := leafCommand("apply", "应用一笔订阅订单", root, apply)
	bindApplyFlags(applyCommand, apply)
	extend := &subscriptionExtendOptions{}
	extendCommand := leafCommand("extend", "把当前订阅延长到指定时间", root, extend)
	extendCommand.Flags().StringVar(&extend.userID, "user-id", "", "业务用户 ID")
	extendCommand.Flags().StringVar(&extend.periodEnd, "period-end", "", "新的到期时间（RFC3339）")
	cancel := &subscriptionUserOptions{}
	cancelCommand := leafCommand("cancel", "取消当前订阅", root, cancel)
	cancelCommand.Flags().StringVar(&cancel.userID, "user-id", "", "业务用户 ID")
	get := &subscriptionUserOptions{}
	getCommand := leafCommand("get", "查询当前订阅", root, &subscriptionGetOptions{subscriptionUserOptions: get})
	getCommand.Flags().StringVar(&get.userID, "user-id", "", "业务用户 ID")
	command.AddCommand(applyCommand, extendCommand, cancelCommand, getCommand)
	return command
}

type subscriptionApplyOptions struct {
	userID         string
	planID         string
	idempotencyKey string
	nickname       string
	phone          string
	periodValue    int
	periodUnit     string
}

func bindApplyFlags(command *cobra.Command, options *subscriptionApplyOptions) {
	flags := command.Flags()
	flags.StringVar(&options.userID, "user-id", "", "业务用户 ID")
	flags.StringVar(&options.planID, "plan-id", "", "订阅计划 ID")
	flags.StringVar(&options.idempotencyKey, "idempotency-key", "", "订单幂等键")
	flags.StringVar(&options.nickname, "nickname", "", "用户昵称")
	flags.StringVar(&options.phone, "phone", "", "用户手机号")
	flags.IntVar(&options.periodValue, "period-value", 0, "订阅周期数；0 使用计划默认值")
	flags.StringVar(&options.periodUnit, "period-unit", "", "周期单位，例如 month")
}

func (o *subscriptionApplyOptions) Validate() error {
	if err := requireValues(map[string]string{"--user-id": o.userID, "--plan-id": o.planID}); err != nil {
		return err
	}
	if o.periodValue < 0 {
		return fmt.Errorf("--period-value 不能小于 0")
	}
	if o.periodValue > 0 && strings.TrimSpace(o.periodUnit) == "" {
		return fmt.Errorf("设置 --period-value 时必须同时设置 --period-unit")
	}
	return nil
}

func (o *subscriptionApplyOptions) input() client.ApplySubscriptionInput {
	return client.ApplySubscriptionInput{
		UserID: o.userID, PlanID: o.planID, IdempotencyKey: o.idempotencyKey,
		Nickname: o.nickname, Phone: o.phone, PeriodValue: o.periodValue, PeriodUnit: o.periodUnit,
	}
}

func (o *subscriptionApplyOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.ApplySubscription(ctx, o.input())
	if err != nil {
		return err
	}
	return renderer.Print("应用订阅", result)
}

type subscriptionExtendOptions struct {
	userID    string
	periodEnd string
}

func (o *subscriptionExtendOptions) Validate() error {
	if err := requireValues(map[string]string{"--user-id": o.userID, "--period-end": o.periodEnd}); err != nil {
		return err
	}
	_, err := parseRFC3339(o.periodEnd)
	return err
}

func (o *subscriptionExtendOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	periodEnd, _ := parseRFC3339(o.periodEnd)
	result, err := api.ExtendSubscription(ctx, client.ExtendSubscriptionInput{UserID: o.userID, NewPeriodEnd: periodEnd})
	if err != nil {
		return err
	}
	return renderer.Print("延长订阅", result)
}

type subscriptionUserOptions struct{ userID string }

func (o *subscriptionUserOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *subscriptionUserOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.CancelSubscription(ctx, o.userID)
	if err != nil {
		return err
	}
	return renderer.Print("取消订阅", result)
}

type subscriptionGetOptions struct{ *subscriptionUserOptions }

func (o *subscriptionGetOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.GetSubscription(ctx, o.userID)
	if err != nil {
		return err
	}
	return renderer.Print("查询订阅", result)
}

func newCtlCreditCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "credit", Short: "查询模型积分权益"}
	options := &creditGetOptions{}
	get := leafCommand("get", "查询用户可用积分", root, options)
	get.Flags().StringVar(&options.userID, "user-id", "", "业务用户 ID")
	command.AddCommand(get)
	return command
}

type creditGetOptions struct{ userID string }

func (o *creditGetOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *creditGetOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.GetCredit(ctx, o.userID)
	if err != nil {
		return err
	}
	return renderer.Print("查询积分", result)
}

func parseRFC3339(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, fmt.Errorf("时间 %q 必须使用 RFC3339，例如 2026-08-31T23:59:59+08:00", value)
	}
	return parsed, nil
}
