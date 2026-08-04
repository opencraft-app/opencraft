package runtimecatalog

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeprompt"
)

var runtimeIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

type Catalog struct {
	registrations []runtimeapi.Registration
}

type Snapshot struct {
	ids              []string
	runtimes         map[string]runtimeapi.ResolvedRuntime
	internalRuntimes map[string]runtimeapi.ResolvedRuntime
}

func New(registrations []runtimeapi.Registration) (*Catalog, error) {
	copied := append([]runtimeapi.Registration(nil), registrations...)
	seenInternal := make(map[string]struct{}, len(copied))
	seenWire := make(map[string]struct{}, len(copied))
	for _, registration := range copied {
		if err := validateRegistration(registration); err != nil {
			return nil, err
		}
		if _, ok := seenInternal[registration.ID]; ok {
			return nil, fmt.Errorf("duplicate Runtime registration %q", registration.ID)
		}
		seenInternal[registration.ID] = struct{}{}
		wireID := effectiveWireID(registration)
		if _, ok := seenWire[wireID]; ok {
			return nil, fmt.Errorf("duplicate Runtime wire identity %q", wireID)
		}
		seenWire[wireID] = struct{}{}
	}
	sort.Slice(copied, func(left int, right int) bool {
		return effectiveWireID(copied[left]) < effectiveWireID(copied[right])
	})
	return &Catalog{registrations: copied}, nil
}

func (c *Catalog) Snapshot(ctx context.Context) *Snapshot {
	snapshot := &Snapshot{
		runtimes:         make(map[string]runtimeapi.ResolvedRuntime),
		internalRuntimes: make(map[string]runtimeapi.ResolvedRuntime),
	}
	if c == nil {
		return snapshot
	}
	for _, registration := range c.registrations {
		driver, err := registration.NewDriver()
		if err != nil || runtimeDriverNil(driver) {
			continue
		}
		probe, err := driver.Probe(ctx)
		if err != nil || !probe.Available {
			continue
		}
		wireID := effectiveWireID(registration)
		resolved := resolvedRuntime(registration, wireID)
		snapshot.ids = append(snapshot.ids, wireID)
		snapshot.runtimes[wireID] = resolved
		snapshot.internalRuntimes[registration.ID] = resolved
	}
	return snapshot
}

func (s *Snapshot) RuntimeIDs() []string {
	if s == nil {
		return nil
	}
	return append([]string(nil), s.ids...)
}

func (s *Snapshot) ResolveRuntime(
	id string,
) (runtimeapi.ResolvedRuntime, bool) {
	if s == nil {
		return runtimeapi.ResolvedRuntime{}, false
	}
	resolved, ok := s.runtimes[id]
	return resolved, ok
}

func (s *Snapshot) ResolveInternalRuntime(
	id string,
) (runtimeapi.ResolvedRuntime, bool) {
	if s == nil {
		return runtimeapi.ResolvedRuntime{}, false
	}
	resolved, ok := s.internalRuntimes[id]
	return resolved, ok
}

func validateRegistration(registration runtimeapi.Registration) error {
	if !runtimeIDPattern.MatchString(registration.ID) {
		return fmt.Errorf("invalid Runtime registration ID %q", registration.ID)
	}
	if registration.WireID != strings.TrimSpace(registration.WireID) {
		return fmt.Errorf("invalid Runtime wire identity %q", registration.WireID)
	}
	if wireID := effectiveWireID(registration); !runtimeIDPattern.MatchString(wireID) {
		return fmt.Errorf("invalid Runtime wire identity %q", wireID)
	}
	if strings.TrimSpace(registration.DisplayName) == "" {
		return fmt.Errorf("Runtime %q requires a display name", registration.ID)
	}
	if registration.NewDriver == nil {
		return fmt.Errorf("Runtime %q requires a Driver factory", registration.ID)
	}
	if registration.LaunchPlanner == nil {
		return fmt.Errorf("Runtime %q requires a launch planner", registration.ID)
	}
	if registration.Policy.Completion != runtimeapi.CompletionEvent {
		return fmt.Errorf(
			"Runtime %q has unsupported completion mode %q",
			registration.ID,
			registration.Policy.Completion,
		)
	}
	switch registration.Policy.BusyMode {
	case runtimeapi.BusyDeliveryNone,
		runtimeapi.BusyDeliveryGated,
		runtimeapi.BusyDeliveryDirect:
	default:
		return fmt.Errorf(
			"Runtime %q has unsupported busy delivery mode %q",
			registration.ID,
			registration.Policy.BusyMode,
		)
	}
	if registration.Policy.BusyMode == runtimeapi.BusyDeliveryDirect &&
		!registration.Policy.SupportsStdin {
		return errors.New(
			"direct busy delivery requires Runtime session input support",
		)
	}
	return nil
}

func resolvedRuntime(
	registration runtimeapi.Registration,
	wireID string,
) runtimeapi.ResolvedRuntime {
	planner := registration.LaunchPlanner
	if wireID != registration.ID {
		planner = wireLaunchPlanner{
			internalID: registration.ID,
			wireID:     wireID,
			next:       planner,
		}
	}
	planner = sharedPolicyLaunchPlanner{next: planner}
	return runtimeapi.ResolvedRuntime{
		ID:            wireID,
		InternalID:    registration.ID,
		DisplayName:   registration.DisplayName,
		NewDriver:     registration.NewDriver,
		Policy:        registration.Policy,
		LaunchPlanner: planner,
	}
}

type sharedPolicyLaunchPlanner struct {
	next runtimeapi.LaunchPlanner
}

func (planner sharedPolicyLaunchPlanner) PlanLaunch(
	input runtimeapi.LaunchInput,
) (runtimeapi.LaunchPlan, error) {
	plan, err := planner.next.PlanLaunch(input)
	if err != nil {
		return runtimeapi.LaunchPlan{}, err
	}
	plan.StandingPrompt, err = runtimeprompt.ComposeStandingPrompt(
		input.AgentID,
		plan.StandingPrompt,
	)
	if err != nil {
		return runtimeapi.LaunchPlan{}, err
	}
	return plan, nil
}

func effectiveWireID(registration runtimeapi.Registration) string {
	wireID := strings.TrimSpace(registration.WireID)
	if wireID == "" {
		return registration.ID
	}
	return wireID
}

type wireLaunchPlanner struct {
	internalID string
	wireID     string
	next       runtimeapi.LaunchPlanner
}

func (planner wireLaunchPlanner) PlanLaunch(
	input runtimeapi.LaunchInput,
) (runtimeapi.LaunchPlan, error) {
	if input.Runtime != planner.wireID {
		return runtimeapi.LaunchPlan{}, fmt.Errorf(
			"wire launch planner for %q received Runtime %q",
			planner.wireID,
			input.Runtime,
		)
	}
	input.Runtime = planner.internalID
	return planner.next.PlanLaunch(input)
}

func runtimeDriverNil(driver runtimeapi.RuntimeDriver) bool {
	if driver == nil {
		return true
	}
	value := reflect.ValueOf(driver)
	switch value.Kind() {
	case reflect.Chan,
		reflect.Func,
		reflect.Interface,
		reflect.Map,
		reflect.Pointer,
		reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}
