package clientcli

import (
	"context"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

type doctorOptions struct{}

func (doctorOptions) Validate() error { return nil }

func (doctorOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	control, err := api.Probe(ctx, client.PlaneControl)
	if err != nil {
		return err
	}
	if err := renderer.Print("检查管理面", control); err != nil {
		return err
	}
	traffic, err := api.Probe(ctx, client.PlaneTraffic)
	if err != nil {
		return err
	}
	return renderer.Print("检查流量面", traffic)
}

func newDoctorCommand(root *rootOptions) *cobra.Command {
	return leafCommand("doctor", "检查管理面与流量面的就绪状态", root, doctorOptions{})
}
