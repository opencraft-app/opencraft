package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/QuantumNous/new-api/common"
	velacli "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/cli"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/daemon"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/localstate"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/managementipc"
)

var ErrComputerControllerUnavailable = errors.New(
	"Vela Computer 控制器尚未接入",
)

type ComputerController interface {
	Setup(context.Context, string, velacli.SetupOptions) error
	Run(context.Context, string) error
}

func (a *Actions) Setup(
	ctx context.Context,
	options velacli.SetupOptions,
) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	if a.config.Controller == nil {
		return ErrComputerControllerUnavailable
	}
	return a.config.Controller.Setup(ctx, root, options)
}

func (a *Actions) DaemonRun(
	ctx context.Context,
	options velacli.DaemonRunOptions,
) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	if a.config.Controller == nil {
		return ErrComputerControllerUnavailable
	}
	return a.config.Controller.Run(ctx, root)
}

func (a *Actions) Status(
	ctx context.Context,
	options velacli.StatusOptions,
) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if err := a.managementClient(root).Call(
		ctx,
		mustRequestID(),
		"status.get",
		map[string]any{},
		&raw,
	); err != nil {
		return err
	}
	if options.JSON {
		_, err = fmt.Fprintf(a.config.Stdout, "%s\n", raw)
		return err
	}
	var status daemon.Status
	if err := common.Unmarshal(raw, &status); err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		a.config.Stdout,
		"Vela Computer：在线\nComputer：%s\n版本：%s\n"+
			"Assignment：%s / %d\n运行 Agent：%d\n",
		status.ComputerID,
		status.Version,
		status.Assignment.Epoch,
		status.Assignment.Revision,
		len(status.Agents),
	)
	return err
}

func (a *Actions) Doctor(
	ctx context.Context,
	options velacli.DoctorOptions,
) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if err := a.managementClient(root).Call(
		ctx,
		mustRequestID(),
		"doctor.run",
		map[string]any{},
		&raw,
	); err != nil {
		return err
	}
	if options.JSON {
		_, err = fmt.Fprintf(a.config.Stdout, "%s\n", raw)
		return err
	}
	var report struct {
		OK         bool   `json:"ok"`
		Daemon     string `json:"daemon"`
		AgentCount int    `json:"agentCount"`
	}
	if err := common.Unmarshal(raw, &report); err != nil {
		return err
	}
	result := "存在故障"
	if report.OK {
		result = "通过"
	}
	_, err = fmt.Fprintf(
		a.config.Stdout,
		"Vela 诊断：%s\nDaemon：%s\n运行 Agent：%d\n",
		result,
		report.Daemon,
		report.AgentCount,
	)
	return err
}

func (a *Actions) Logs(
	ctx context.Context,
	options velacli.LogsOptions,
) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	return a.managementClient(root).Stream(
		ctx,
		mustRequestID(),
		"logs.tail",
		map[string]any{
			"follow": options.Follow,
			"lines":  options.Lines,
		},
		func(response managementipc.Response) error {
			var event logEvent
			if err := common.Unmarshal(response.Event, &event); err != nil {
				return err
			}
			_, err := fmt.Fprintf(
				a.config.Stdout,
				"%s %-5s %-12s %s\n",
				event.Timestamp.Local().Format("2006-01-02 15:04:05"),
				event.Level,
				event.Component,
				event.Message,
			)
			return err
		},
	)
}

func (a *Actions) resolveStateRoot(explicit string) (string, error) {
	if explicit == "" && a.config.Root != "" {
		return a.config.Root, nil
	}
	return localstate.ResolveRoot(explicit, os.Getenv, os.Getwd)
}

func (a *Actions) managementClient(
	root string,
) *managementipc.Client {
	return managementipc.NewClient(
		filepath.Join(root, "daemon.sock"),
		a.config.Version,
	)
}

func mustRequestID() string {
	value, err := newID()
	if err != nil {
		panic(err)
	}
	return value
}

type logEvent struct {
	Timestamp time.Time `json:"timestamp"`
	Level     string    `json:"level"`
	Component string    `json:"component"`
	Message   string    `json:"message"`
}
