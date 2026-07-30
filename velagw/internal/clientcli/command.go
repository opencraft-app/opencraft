package clientcli

import (
	"context"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

type leafOptions interface {
	Validate() error
	Run(context.Context, *client.Client, ui.Renderer) error
}

func executeLeaf(cmd *cobra.Command, root *rootOptions, options leafOptions) error {
	if err := options.Validate(); err != nil {
		return err
	}
	api, err := root.client()
	if err != nil {
		return err
	}
	return options.Run(cmd.Context(), api, root.renderer())
}

func leafCommand(use string, short string, root *rootOptions, options leafOptions) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return executeLeaf(cmd, root, options)
		},
	}
}
