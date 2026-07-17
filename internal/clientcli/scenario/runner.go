package scenario

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
)

type ControlGateway interface {
	EnsureUser(context.Context, client.EnsureUserInput) (client.Result, error)
	GetAssignment(context.Context, string) (client.Result, error)
	ApplySubscription(context.Context, client.ApplySubscriptionInput) (client.Result, error)
	ExtendSubscription(context.Context, client.ExtendSubscriptionInput) (client.Result, error)
	CancelSubscription(context.Context, string) (client.Result, error)
	GetSubscription(context.Context, string) (client.Result, error)
	GetCredit(context.Context, string) (client.Result, error)
	SetBYOK(context.Context, string, client.BYOKSettingsInput) (client.Result, error)
	SyncBYOK(context.Context, string) (client.Result, error)
	GetBYOK(context.Context, string) (client.Result, error)
	CreateAPIKey(context.Context, string, string) (client.Result, error)
}

type TrafficGateway interface {
	Models(context.Context) (client.Result, error)
	Chat(context.Context, client.ChatInput) (client.Result, error)
}

type Runner struct {
	Gateway       ControlGateway
	TrafficForKey func(string) TrafficGateway
}

type StepStatus string

const (
	StepSucceeded StepStatus = "succeeded"
	StepFailed    StepStatus = "failed"
)

type Step struct {
	Name   string        `json:"name"`
	Status StepStatus    `json:"status"`
	Result client.Result `json:"result"`
	Error  string        `json:"error,omitempty"`
}

type Report struct {
	Scenario string `json:"scenario"`
	Steps    []Step `json:"steps"`
	APIKey   string `json:"api_key,omitempty"`
}

type TradeLifecycleInput struct {
	UserID         string
	Nickname       string
	PlanID         string
	IdempotencyKey string
	PeriodValue    int
	PeriodUnit     string
	NewPeriodEnd   time.Time
}

type OnboardInput struct {
	UserID         string
	Nickname       string
	Phone          string
	PlanID         string
	IdempotencyKey string
	PeriodValue    int
	PeriodUnit     string
	KeyName        string
}

type RenewInput struct {
	Apply        client.ApplySubscriptionInput
	NewPeriodEnd time.Time
}

type BYOKInput struct {
	UserID   string
	Settings client.BYOKSettingsInput
}

type FullInput struct {
	Onboard OnboardInput
	BYOK    BYOKInput
	Chat    client.ChatInput
}

type stepCall func() (client.Result, error)

type plannedStep struct {
	name string
	call stepCall
}

func (r Runner) TradeLifecycle(ctx context.Context, input TradeLifecycleInput) (Report, error) {
	report := Report{Scenario: "trade-lifecycle"}
	apply := client.ApplySubscriptionInput{
		UserID: input.UserID, PlanID: input.PlanID, Nickname: input.Nickname,
		IdempotencyKey: input.IdempotencyKey, PeriodValue: input.PeriodValue, PeriodUnit: input.PeriodUnit,
	}
	steps := []plannedStep{
		{"确保租户存在", func() (client.Result, error) {
			return r.Gateway.EnsureUser(ctx, client.EnsureUserInput{UserID: input.UserID, Nickname: input.Nickname})
		}},
		{"查询租户归属", func() (client.Result, error) { return r.Gateway.GetAssignment(ctx, input.UserID) }},
		{"应用订阅", func() (client.Result, error) { return r.Gateway.ApplySubscription(ctx, apply) }},
		{"查询订阅", func() (client.Result, error) { return r.Gateway.GetSubscription(ctx, input.UserID) }},
		{"查询积分", func() (client.Result, error) { return r.Gateway.GetCredit(ctx, input.UserID) }},
	}
	if !input.NewPeriodEnd.IsZero() {
		steps = append(steps,
			plannedStep{"延长订阅", func() (client.Result, error) {
				return r.Gateway.ExtendSubscription(ctx, client.ExtendSubscriptionInput{UserID: input.UserID, NewPeriodEnd: input.NewPeriodEnd})
			}},
			plannedStep{"确认续期结果", func() (client.Result, error) { return r.Gateway.GetSubscription(ctx, input.UserID) }},
		)
	}
	steps = append(steps,
		plannedStep{"取消订阅", func() (client.Result, error) { return r.Gateway.CancelSubscription(ctx, input.UserID) }},
		plannedStep{"确认取消结果", func() (client.Result, error) {
			result, err := r.Gateway.GetSubscription(ctx, input.UserID)
			if client.IsStatus(err, http.StatusNotFound) {
				return result, nil
			}
			return result, err
		}},
	)
	return runSteps(report, steps)
}

func (r Runner) Onboard(ctx context.Context, input OnboardInput) (Report, error) {
	report := Report{Scenario: "onboard"}
	apply := client.ApplySubscriptionInput{
		UserID: input.UserID, PlanID: input.PlanID, Nickname: input.Nickname, Phone: input.Phone,
		IdempotencyKey: input.IdempotencyKey, PeriodValue: input.PeriodValue, PeriodUnit: input.PeriodUnit,
	}
	steps := []plannedStep{
		{"确保租户存在", func() (client.Result, error) {
			return r.Gateway.EnsureUser(ctx, client.EnsureUserInput{UserID: input.UserID, Nickname: input.Nickname})
		}},
		{"应用订阅", func() (client.Result, error) { return r.Gateway.ApplySubscription(ctx, apply) }},
		{"签发模型密钥", func() (client.Result, error) { return r.Gateway.CreateAPIKey(ctx, input.UserID, input.KeyName) }},
	}
	var err error
	report, err = runSteps(report, steps)
	if err != nil || len(report.Steps) == 0 {
		return report, err
	}
	var key client.APIKey
	if decodeErr := report.Steps[len(report.Steps)-1].Result.Decode(&key); decodeErr != nil {
		return report, fmt.Errorf("读取新签发密钥: %w", decodeErr)
	}
	report.APIKey = key.APIKey
	return report, nil
}

func (r Runner) Renew(ctx context.Context, input RenewInput) (Report, error) {
	report := Report{Scenario: "renew"}
	steps := []plannedStep{
		{"应用续费订单", func() (client.Result, error) { return r.Gateway.ApplySubscription(ctx, input.Apply) }},
	}
	if !input.NewPeriodEnd.IsZero() {
		steps = append(steps, plannedStep{"对齐有效期", func() (client.Result, error) {
			return r.Gateway.ExtendSubscription(ctx, client.ExtendSubscriptionInput{UserID: input.Apply.UserID, NewPeriodEnd: input.NewPeriodEnd})
		}})
	}
	steps = append(steps,
		plannedStep{"查询续费结果", func() (client.Result, error) { return r.Gateway.GetSubscription(ctx, input.Apply.UserID) }},
		plannedStep{"查询积分", func() (client.Result, error) { return r.Gateway.GetCredit(ctx, input.Apply.UserID) }},
	)
	return runSteps(report, steps)
}

func (r Runner) Cancel(ctx context.Context, userID string) (Report, error) {
	report := Report{Scenario: "cancel"}
	return runSteps(report, []plannedStep{
		{"取消订阅", func() (client.Result, error) { return r.Gateway.CancelSubscription(ctx, userID) }},
		{"确认取消结果", func() (client.Result, error) {
			result, err := r.Gateway.GetSubscription(ctx, userID)
			if client.IsStatus(err, http.StatusNotFound) {
				return result, nil
			}
			return result, err
		}},
	})
}

func (r Runner) BYOK(ctx context.Context, input BYOKInput) (Report, error) {
	report := Report{Scenario: "byok"}
	return runSteps(report, []plannedStep{
		{"保存 BYOK 设置", func() (client.Result, error) { return r.Gateway.SetBYOK(ctx, input.UserID, input.Settings) }},
		{"提交异步同步", func() (client.Result, error) { return r.Gateway.SyncBYOK(ctx, input.UserID) }},
		{"读取 BYOK 状态", func() (client.Result, error) { return r.Gateway.GetBYOK(ctx, input.UserID) }},
	})
}

func (r Runner) Full(ctx context.Context, input FullInput) (Report, error) {
	report, err := r.Onboard(ctx, input.Onboard)
	report.Scenario = "full"
	if err != nil {
		return report, err
	}
	byok, err := r.BYOK(ctx, input.BYOK)
	report.Steps = append(report.Steps, byok.Steps...)
	if err != nil {
		return report, err
	}
	key := strings.TrimSpace(report.APIKey)
	if key == "" && len(report.Steps) > 0 && report.Steps[len(report.Steps)-1].Result.DryRun {
		key = "sk-dry-run-placeholder"
	}
	if key == "" {
		return report, fmt.Errorf("签发结果未包含 api_key，无法继续流量验收")
	}
	if r.TrafficForKey == nil {
		return report, fmt.Errorf("未配置流量客户端工厂")
	}
	traffic := r.TrafficForKey(key)
	trafficReport, err := runSteps(Report{Scenario: "full"}, []plannedStep{
		{"查询模型列表", func() (client.Result, error) { return traffic.Models(ctx) }},
		{"发送模型请求", func() (client.Result, error) { return traffic.Chat(ctx, input.Chat) }},
		{"查询最终积分", func() (client.Result, error) { return r.Gateway.GetCredit(ctx, input.Onboard.UserID) }},
	})
	report.Steps = append(report.Steps, trafficReport.Steps...)
	return report, err
}

func runSteps(report Report, steps []plannedStep) (Report, error) {
	for _, planned := range steps {
		result, err := planned.call()
		step := Step{Name: planned.name, Status: StepSucceeded, Result: result}
		if err != nil {
			step.Status = StepFailed
			step.Error = err.Error()
			report.Steps = append(report.Steps, step)
			return report, fmt.Errorf("%s: %w", planned.name, err)
		}
		report.Steps = append(report.Steps, step)
	}
	return report, nil
}
