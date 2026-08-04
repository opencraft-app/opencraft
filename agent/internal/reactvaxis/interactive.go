package reactvaxis

import (
	"context"
	"time"

	"go.rockorager.dev/vaxis"
	"go.rockorager.dev/vaxis/ui"
)

// Snapshot renders the next React commit through the same Vaxis widget tree
// used by the interactive terminal. It is intentionally deterministic for CI.
func Snapshot(ctx context.Context, runtime *Runtime, width, height int) (string, error) {
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		return "", err
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(tree), width, height)
	return harness.Snapshot(), nil
}

// RunInteractive opens the real Vaxis backend and owns the terminal until the
// React application exits. Runtime ownership remains with the caller.
func RunInteractive(runtime *Runtime) error {
	return RunInteractiveWithKittyFlags(runtime, DefaultKittyKeyboardFlags)
}

func RunInteractiveWithKittyFlags(runtime *Runtime, flags vaxis.CSIuBitMask) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	initial, err := runtime.NextCommit(ctx)
	cancel()
	if err != nil {
		return err
	}
	return runTerminal(reactiveRoot{runtime: runtime, initial: initial}, flags)
}

type reactiveRoot struct {
	runtime *Runtime
	initial *NativeNode
}

func (w reactiveRoot) CreateState() ui.State {
	return &reactiveRootState{runtime: w.runtime, tree: w.initial}
}

type reactiveRootState struct {
	ui.StateBase
	runtime *Runtime
	tree    *NativeNode
	cancel  context.CancelFunc
}

func (s *reactiveRootState) InitState() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	dispatcher := s.Context().Runtime()
	go func() {
		for {
			tree, err := s.runtime.NextCommit(ctx)
			if err != nil {
				return
			}
			dispatcher.Dispatch(func() {
				s.SetState(func() { s.tree = tree })
			})
		}
	}()
}

func (s *reactiveRootState) Dispose() {
	if s.cancel != nil {
		s.cancel()
	}
}

func (s *reactiveRootState) HandleEvent(ctx ui.EventContext, event ui.Event) ui.EventResult {
	if ctx.Phase() != ui.CapturePhase {
		return ui.EventIgnored
	}
	resize, ok := event.(vaxis.Resize)
	if !ok {
		return ui.EventIgnored
	}
	s.runtime.Resize(resize.Cols, resize.Rows)
	return ui.EventIgnored
}

func (s *reactiveRootState) Build(ui.BuildContext) ui.Widget {
	adapter := NewVaxisAdapter(func(event NativeEvent) {
		payload := map[string]any{"source": event.Source}
		switch event.ValueKind {
		case NativeBoolValue:
			payload["value"] = event.BoolValue
		case NativeStringValue:
			payload["value"] = event.Value
		}
		if event.EventCount > 0 {
			payload["eventCount"] = event.EventCount
		}
		s.runtime.Dispatch(event.HandlerID, payload)
	})
	return rootInteractionShell(adapter.Build(s.tree))
}

func rootInteractionShell(child ui.Widget) ui.Widget {
	quit := quitIntent{}
	quitAction := func(ctx ui.EventContext, _ ui.Intent) ui.EventResult {
		ctx.Quit()
		return ui.EventHandled
	}
	return ui.Shortcuts{
		Bindings: ui.ShortcutMap{"Ctrl+c": quit},
		Child: ui.Actions{
			Bindings: map[ui.IntentType]ui.ActionFunc{quit.IntentType(): quitAction},
			Child: ui.DefaultActions{
				Bindings: map[ui.IntentType]ui.ActionFunc{ui.DismissIntentType: quitAction},
				Child:    child,
			},
		},
	}
}

type quitIntent struct{}

func (quitIntent) IntentType() ui.IntentType { return "vela.reactvaxis.quit" }
