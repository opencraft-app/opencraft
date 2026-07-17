package clientcli

import (
	"context"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newAdminCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "admin", Short: "模拟运营管理操作"}
	tenant := &cobra.Command{Use: "tenant", Short: "查看租户聚合状态"}
	show := &adminTenantShowOptions{}
	showCommand := leafCommand("show", "查看一个租户", root, show)
	showCommand.Flags().StringVar(&show.userID, "user-id", "", "业务用户 ID")
	tenant.AddCommand(showCommand)

	key := &cobra.Command{Use: "key", Short: "签发用户模型密钥"}
	create := &adminKeyCreateOptions{name: "default"}
	createCommand := leafCommand("create", "为用户签发 sk-... 密钥", root, create)
	createCommand.Flags().StringVar(&create.userID, "user-id", "", "业务用户 ID")
	createCommand.Flags().StringVar(&create.name, "name", create.name, "密钥名称")
	key.AddCommand(createCommand)
	command.AddCommand(tenant, key)
	return command
}

type adminTenantShowOptions struct{ userID string }

func (o *adminTenantShowOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *adminTenantShowOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.ShowTenant(ctx, o.userID)
	if err != nil {
		return err
	}
	return renderer.Print("查看租户", result)
}

type adminKeyCreateOptions struct {
	userID string
	name   string
}

func (o *adminKeyCreateOptions) Validate() error {
	return requireValues(map[string]string{"--user-id": o.userID})
}

func (o *adminKeyCreateOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.CreateAPIKey(ctx, o.userID, o.name)
	if err != nil {
		return err
	}
	return renderer.Print("签发模型密钥", result)
}
