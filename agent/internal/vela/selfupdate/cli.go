package selfupdate

import (
	"context"
	"flag"
	"io"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

type applyCommandConfig struct {
	StateRoot        string
	InstallationRoot string
	TransactionID    string
	ParentPID        int
	Target           string
}

func RunApplyCommand(ctx context.Context, args []string) error {
	config, err := parseApplyCommand(args)
	if err != nil {
		return err
	}
	services, err := NewPlatformMainServiceManager()
	if err != nil {
		return err
	}
	helper, err := NewApplyHelper(ApplyHelperConfig{
		StateRoot: config.StateRoot, InstallationRoot: config.InstallationRoot,
		TransactionID: config.TransactionID, ParentPID: config.ParentPID, Target: config.Target,
		Now: time.Now, Parent: NewProcessParentWaiter(100 * time.Millisecond),
		Services: services, Health: NewFileHealthWaiter(500 * time.Millisecond),
		ParentTimeout: 2 * time.Minute, HealthTimeout: 2 * time.Minute,
	})
	if err != nil {
		return err
	}
	return helper.Apply(ctx)
}

func parseApplyCommand(args []string) (applyCommandConfig, error) {
	if len(args) == 0 || args[0] != "apply" {
		return applyCommandConfig{}, ErrTransactionInvalid
	}
	var config applyCommandConfig
	flags := flag.NewFlagSet("upgrade apply", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&config.StateRoot, "state-dir", "", "")
	flags.StringVar(&config.TransactionID, "transaction-id", "", "")
	flags.IntVar(&config.ParentPID, "parent-pid", 0, "")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 ||
		!cleanAbsolute(config.StateRoot) || filepath.Base(config.StateRoot) != "state" ||
		config.ParentPID <= 0 {
		return applyCommandConfig{}, ErrTransactionInvalid
	}
	parsedID, err := uuid.Parse(config.TransactionID)
	if err != nil || parsedID.Version() != 7 {
		return applyCommandConfig{}, ErrTransactionInvalid
	}
	config.InstallationRoot = filepath.Dir(config.StateRoot)
	config.Target = currentTarget()
	return config, nil
}
