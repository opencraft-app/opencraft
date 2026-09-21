package gojaim

import (
	"errors"
	"fmt"
	"time"

	"github.com/dop251/goja"
)

const probeTimeout = 5 * time.Second

type BundleInfo struct {
	Version   string
	HasCreate bool
	HasFacade bool
	ClientID  string
}

func ProbeEmbeddedBundle() (BundleInfo, error) {
	source := EmbeddedBundle()
	if err := ValidateBundle(source); err != nil {
		return BundleInfo{}, err
	}

	vm := goja.New()
	if err := installProbeHost(vm); err != nil {
		return BundleInfo{}, err
	}
	timer := time.AfterFunc(probeTimeout, func() {
		vm.Interrupt("LiteChat bundle probe timed out")
	})
	_, err := vm.RunString(source)
	if !timer.Stop() {
		return BundleInfo{}, fmt.Errorf("%w: execution timeout", ErrInvalidBundle)
	}
	if err != nil {
		return BundleInfo{}, fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}

	sdk := vm.Get("TencentCloudChat")
	sdkObject, ok := sdk.(*goja.Object)
	if !ok {
		return BundleInfo{}, ErrInvalidBundle
	}
	_, hasCreate := goja.AssertFunction(sdkObject.Get("create"))

	facade := vm.Get("__velaLiteChat")
	facadeObject, ok := facade.(*goja.Object)
	if !ok {
		return BundleInfo{}, ErrInvalidBundle
	}
	requiredFacadeMethods := []string{
		"create",
		"command",
		"close",
		"drainEvents",
	}
	hasFacade := true
	for _, method := range requiredFacadeMethods {
		if _, ok := goja.AssertFunction(facadeObject.Get(method)); !ok {
			hasFacade = false
			break
		}
	}
	var clientID string
	if hasFacade {
		create, _ := goja.AssertFunction(facadeObject.Get("create"))
		value, createErr := create(
			goja.Undefined(),
			vm.ToValue(map[string]any{"SDKAppID": 1_400_000_000}),
		)
		if createErr != nil {
			return BundleInfo{}, fmt.Errorf(
				"%w: create: %v",
				ErrInvalidBundle,
				createErr,
			)
		}
		clientID = value.String()
	}

	return BundleInfo{
		Version:   sdkObject.Get("VERSION").String(),
		HasCreate: hasCreate,
		HasFacade: hasFacade,
		ClientID:  clientID,
	}, nil
}

func installProbeHost(vm *goja.Runtime) error {
	noop := func(goja.FunctionCall) goja.Value {
		return goja.Undefined()
	}
	open := func(goja.FunctionCall) goja.Value {
		return vm.ToValue(1)
	}
	host := map[string]any{
		"websocket": map[string]any{
			"open":  open,
			"send":  noop,
			"close": noop,
		},
		"fetch": map[string]any{
			"start": open,
			"abort": noop,
		},
	}
	if err := vm.Set("__velaHost", host); err != nil {
		return errors.Join(ErrInvalidBundle, err)
	}
	if err := vm.Set("setTimeout", open); err != nil {
		return errors.Join(ErrInvalidBundle, err)
	}
	if err := vm.Set("clearTimeout", noop); err != nil {
		return errors.Join(ErrInvalidBundle, err)
	}
	if err := vm.Set("setInterval", open); err != nil {
		return errors.Join(ErrInvalidBundle, err)
	}
	if err := vm.Set("clearInterval", noop); err != nil {
		return errors.Join(ErrInvalidBundle, err)
	}
	return nil
}
