package hermes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"velachat/agent/internal/filelock"
)

const (
	managedProfileMarkerName    = ".vela-computer-profile.json"
	managedProfileMarkerSchema  = 1
	managedProfileNaming        = "sha256-128-v1"
	managedProfileClient        = "vela-computer"
	profileCommandOutputMaximum = 64 * 1024
	defaultProfileLockWait      = 5 * time.Second
	profileLockPollInterval     = 25 * time.Millisecond
)

var ErrProfileProvisioningBusy = errors.New(
	"Hermes Profile provisioning is busy",
)

type profileCommandRequest struct {
	Path        string
	Args        []string
	Environment map[string]string
}

type profileCommandRunner func(
	context.Context,
	profileCommandRequest,
) ([]byte, error)

type profileProvisionerOptions struct {
	TrustedHome string
	Candidate   executableCandidate
	Run         profileCommandRunner
	Now         func() time.Time
	LockWait    time.Duration
}

type nativeProfileProvisioner struct {
	trustedHome string
	candidate   executableCandidate
	run         profileCommandRunner
	now         func() time.Time
	lockWait    time.Duration
}

type managedProfileMarker struct {
	Schema      int       `json:"schema"`
	AgentID     string    `json:"agentId"`
	ProfileName string    `json:"profileName"`
	ProfileHome string    `json:"profileHome"`
	Template    string    `json:"template"`
	Naming      string    `json:"naming"`
	Client      string    `json:"client"`
	CreatedAt   time.Time `json:"createdAt"`
}

func newNativeProfileProvisioner(
	options profileProvisionerOptions,
) (*nativeProfileProvisioner, error) {
	trustedHome := strings.TrimSpace(options.TrustedHome)
	if trustedHome == "" || !filepath.IsAbs(trustedHome) {
		return nil, errors.New(
			"Hermes Profile provisioner requires an absolute trusted home",
		)
	}
	if strings.TrimSpace(options.Candidate.Path) == "" {
		return nil, errors.New(
			"Hermes Profile provisioner requires an executable",
		)
	}
	run := options.Run
	if run == nil {
		run = runProfileCommand
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	lockWait := options.LockWait
	if lockWait <= 0 {
		lockWait = defaultProfileLockWait
	}
	return &nativeProfileProvisioner{
		trustedHome: filepath.Clean(trustedHome),
		candidate: executableCandidate{
			Path:       strings.TrimSpace(options.Candidate.Path),
			ArgsPrefix: append([]string(nil), options.Candidate.ArgsPrefix...),
		},
		run:      run,
		now:      now,
		lockWait: lockWait,
	}, nil
}

func (p *nativeProfileProvisioner) Ensure(
	ctx context.Context,
	agentID string,
) (profileSelection, error) {
	selection, err := managedProfileSelection(p.trustedHome, agentID)
	if err != nil {
		return profileSelection{}, err
	}
	defaultHome := filepath.Join(p.trustedHome, ".hermes")
	if err := requireDirectory(defaultHome); err != nil {
		return profileSelection{}, fmt.Errorf(
			"Hermes default Profile is unavailable: %w",
			err,
		)
	}
	lock, err := p.acquireProfileLock(ctx, selection.Name)
	if err != nil {
		return profileSelection{}, err
	}
	defer lock.Release()

	transaction, hasTransaction, err := p.readTransaction(agentID, selection)
	if err != nil {
		return profileSelection{}, err
	}
	info, statErr := os.Lstat(selection.Home)
	switch {
	case statErr == nil:
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return profileSelection{}, errors.New(
				"Hermes managed Profile path is unsafe",
			)
		}
		markerErr := validateManagedProfileMarker(selection, agentID)
		if markerErr == nil {
			if hasTransaction {
				if transaction.Phase == profileTransactionScrubbed {
					transaction.Phase = profileTransactionCommitted
					if err := p.writeTransaction(transaction); err != nil {
						return profileSelection{}, err
					}
				} else if transaction.Phase != profileTransactionCommitted {
					return profileSelection{}, errors.New(
						"Hermes managed Profile transaction conflicts with ownership",
					)
				}
				if err := p.removeTransaction(selection.Name); err != nil {
					return profileSelection{}, err
				}
			}
			return selection, nil
		}
		if !errors.Is(markerErr, os.ErrNotExist) {
			return profileSelection{}, markerErr
		}
		if !hasTransaction {
			return profileSelection{}, errors.New(
				"Hermes managed Profile collides with an unmanaged directory",
			)
		}
		switch transaction.Phase {
		case profileTransactionPlanned:
			return profileSelection{}, errors.New(
				"Hermes Profile provisioning is ambiguous: " +
					"a planned transaction has a markerless target",
			)
		case profileTransactionNativeCreated, profileTransactionScrubbed:
			return p.finishProvisioning(transaction, selection)
		case profileTransactionCommitted:
			return profileSelection{}, errors.New(
				"Hermes committed Profile transaction is missing ownership",
			)
		default:
			return profileSelection{}, errors.New(
				"Hermes Profile transaction phase is invalid",
			)
		}
	case !errors.Is(statErr, os.ErrNotExist):
		return profileSelection{}, statErr
	}
	if hasTransaction && transaction.Phase != profileTransactionPlanned {
		return profileSelection{}, errors.New(
			"Hermes Profile transaction target is missing",
		)
	}
	if !hasTransaction {
		transaction, err = p.newTransaction(agentID, selection)
		if err != nil {
			return profileSelection{}, err
		}
		if err := p.writeTransaction(transaction); err != nil {
			return profileSelection{}, err
		}
	}

	environment := hostProfileEnvironment(p.trustedHome)
	args := append([]string(nil), p.candidate.ArgsPrefix...)
	args = append(
		args,
		"profile",
		"create",
		selection.Name,
		"--clone",
		"--clone-from",
		"default",
		"--no-alias",
	)
	output, err := p.run(ctx, profileCommandRequest{
		Path:        p.candidate.Path,
		Args:        args,
		Environment: environment,
	})
	if err != nil {
		return profileSelection{}, fmt.Errorf(
			"create Hermes managed Profile: %w: %s",
			err,
			boundedDiagnostic(output),
		)
	}
	if err := requireDirectory(selection.Home); err != nil {
		return profileSelection{}, fmt.Errorf(
			"Hermes Profile create did not produce the managed directory: %w",
			err,
		)
	}
	transaction.Phase = profileTransactionNativeCreated
	if err := p.writeTransaction(transaction); err != nil {
		return profileSelection{}, err
	}
	return p.finishProvisioning(transaction, selection)
}

func (p *nativeProfileProvisioner) lockPath(profileName string) string {
	return filepath.Join(
		p.trustedHome,
		".hermes",
		".vela-computer",
		"profile-locks",
		profileName+".lock",
	)
}

func (p *nativeProfileProvisioner) acquireProfileLock(
	ctx context.Context,
	profileName string,
) (*filelock.Lock, error) {
	deadline := time.Now().Add(p.lockWait)
	for {
		lock, err := filelock.Acquire(p.lockPath(profileName))
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, filelock.ErrLocked) {
			return nil, fmt.Errorf(
				"acquire Hermes Profile provisioning lock: %w",
				err,
			)
		}
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf(
				"%w: %v",
				ErrProfileProvisioningBusy,
				err,
			)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, ErrProfileProvisioningBusy
		}
		wait := profileLockPollInterval
		if remaining < wait {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, fmt.Errorf(
				"%w: %v",
				ErrProfileProvisioningBusy,
				ctx.Err(),
			)
		case <-timer.C:
		}
	}
}

func (p *nativeProfileProvisioner) finishProvisioning(
	transaction managedProfileTransaction,
	selection profileSelection,
) (profileSelection, error) {
	if transaction.Phase != profileTransactionNativeCreated &&
		transaction.Phase != profileTransactionScrubbed {
		return profileSelection{}, errors.New(
			"Hermes Profile transaction cannot be committed",
		)
	}
	if err := enforceManagedProfilePostconditions(selection.Home); err != nil {
		return profileSelection{}, fmt.Errorf(
			"validate Hermes managed Profile: %w",
			err,
		)
	}
	if transaction.Phase == profileTransactionNativeCreated {
		transaction.Phase = profileTransactionScrubbed
		if err := p.writeTransaction(transaction); err != nil {
			return profileSelection{}, err
		}
	}
	marker := managedProfileMarker{
		Schema:      managedProfileMarkerSchema,
		AgentID:     transaction.AgentID,
		ProfileName: selection.Name,
		ProfileHome: selection.Home,
		Template:    "default",
		Naming:      managedProfileNaming,
		Client:      managedProfileClient,
		CreatedAt:   transaction.CreatedAt,
	}
	if err := writeManagedProfileMarker(selection.Home, marker); err != nil {
		return profileSelection{}, fmt.Errorf(
			"write Hermes managed Profile ownership: %w",
			err,
		)
	}
	transaction.Phase = profileTransactionCommitted
	if err := p.writeTransaction(transaction); err != nil {
		return profileSelection{}, err
	}
	if err := p.removeTransaction(selection.Name); err != nil {
		return profileSelection{}, err
	}
	return selection, nil
}

func validateManagedProfileMarker(
	selection profileSelection,
	agentID string,
) error {
	var marker managedProfileMarker
	if err := readManagedProfileMarker(selection.Home, &marker); err != nil {
		return err
	}
	if marker.Schema != managedProfileMarkerSchema ||
		marker.AgentID != agentID ||
		marker.ProfileName != selection.Name ||
		filepath.Clean(marker.ProfileHome) != selection.Home ||
		marker.Template != "default" ||
		marker.Naming != managedProfileNaming ||
		marker.Client != managedProfileClient {
		return errors.New(
			"Hermes managed Profile ownership marker does not match the Agent",
		)
	}
	return nil
}

func runProfileCommand(
	ctx context.Context,
	request profileCommandRequest,
) ([]byte, error) {
	command := exec.CommandContext(ctx, request.Path, request.Args...)
	command.Stdin = nil
	command.Env = environmentList(request.Environment)
	return command.CombinedOutput()
}

func hostProfileEnvironment(trustedHome string) map[string]string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found {
			environment[key] = value
		}
	}
	environment["HOME"] = trustedHome
	delete(environment, "HERMES_HOME")
	delete(environment, "HERMES_PROFILE")
	return environment
}

func boundedDiagnostic(output []byte) string {
	if len(output) > profileCommandOutputMaximum {
		output = output[:profileCommandOutputMaximum]
	}
	return strings.TrimSpace(string(output))
}
