package clientcli

import (
	"context"

	"github.com/spf13/cobra"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli/ui"
)

func newTrafficCommand(root *rootOptions) *cobra.Command {
	command := &cobra.Command{Use: "traffic", Short: "使用终端用户 Key 调用模型"}
	models := leafCommand("models", "查询当前 Key 可见的模型", root, trafficModelsOptions{})
	chat := &trafficChatOptions{model: "auto", prompt: "你好"}
	chatCommand := leafCommand("chat", "发送一次 OpenAI 兼容聊天请求", root, chat)
	chatCommand.Flags().StringVar(&chat.model, "model", chat.model, "模型或虚拟模型 ID")
	chatCommand.Flags().StringVar(&chat.prompt, "prompt", chat.prompt, "用户消息")
	chatCommand.Flags().StringVar(&chat.system, "system", "", "系统消息")
	chatCommand.Flags().BoolVar(&chat.stream, "stream", false, "使用流式响应")
	command.AddCommand(models, chatCommand)
	return command
}

type trafficModelsOptions struct{}

func (trafficModelsOptions) Validate() error { return nil }

func (trafficModelsOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.Models(ctx)
	if err != nil {
		return err
	}
	return renderer.Print("查询模型列表", result)
}

type trafficChatOptions struct {
	model  string
	prompt string
	system string
	stream bool
}

func (o *trafficChatOptions) Validate() error {
	return requireValues(map[string]string{"--model": o.model, "--prompt": o.prompt})
}

func (o *trafficChatOptions) Run(ctx context.Context, api *client.Client, renderer ui.Renderer) error {
	result, err := api.Chat(ctx, client.ChatInput{Model: o.model, Prompt: o.prompt, System: o.system, Stream: o.stream})
	if err != nil {
		return err
	}
	return renderer.Print("发送模型请求", result)
}
