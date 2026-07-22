package clientcli

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newCtlCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "ctl", Short: "模拟 trade/ctl 内部业务调用"}
	command.AddCommand(newCtlTenantCommand(root), newCtlSubscriptionCommand(root), newCtlCreditCommand(root), newCtlBYOKCommand(root))
	return command
}

func newCtlTenantCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "tenant", Short: "维护租户及其 Set 归属"}
	ensure := &tenantEnsureOptions{}
	ensureCommand := leafCommand("ensure", "确保租户已经进入 LLMGateway", root, ensure)
	ensureCommand.Flags().StringVar(&ensure.userID, "user-id", "", "业务用户 ID")
	ensureCommand.Flags().StringVar(&ensure.nickname, "nickname", "", "用户昵称")

	assignment := &cobra.Command{Use: "assignment", Short: "读取或调整新老后端归属"}
	get := &assignmentGetOptions{}
	getCommand := leafCommand("get", "查询用户归属", root, get)
	getCommand.Flags().StringVar(&get.userID, "user-id", "", "业务用户 ID")
	set := &assignmentSetOptions{}
	setCommand := leafCommand("set", "设置用户归属", root, set)
	setCommand.Flags().StringVar(&set.userID, "user-id", "", "业务用户 ID")
	setCommand.Flags().StringVar(&set.backend, "backend", "", "承载状态：pending 或 new")
	setCommand.Flags().StringVar(&set.setID, "set-id", "", "指定 Set；留空时由控制面选择")
	assignment.AddCommand(getCommand, setCommand)
	command.AddCommand(ensureCommand, assignment)
	return command
}

type tenantEnsureOptions struct {
	userID   string
	nickname string
}

func (o *tenantEnsureOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *tenantEnsureOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.EnsureUser(ctx, client.EnsureUserInput{UserID: o.userID, Nickname: o.nickname})
	if err != nil {
		return err
	}
	return renderer.Print("确保租户存在", result)
}

type assignmentGetOptions struct{ userID string }

func (o *assignmentGetOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *assignmentGetOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.GetAssignment(ctx, o.userID)
	if err != nil {
		return err
	}
	return renderer.Print("查询租户归属", result)
}

type assignmentSetOptions struct {
	userID  string
	backend string
	setID   string
}

func (o *assignmentSetOptions) Validate() error {
	if err := requireValues(map[string]string{"--user-id": o.userID, "--backend": o.backend}); err != nil {
		return err
	}
	backend := strings.ToLower(strings.TrimSpace(o.backend))
	if backend != "pending" && backend != "new" {
		return fmt.Errorf("--backend 只支持 pending 或 new")
	}
	o.backend = backend
	return nil
}

func (o *assignmentSetOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.SetAssignment(ctx, o.userID, client.AssignmentInput{Backend: o.backend, SetID: o.setID})
	if err != nil {
		return err
	}
	return renderer.Print("设置租户归属", result)
}
