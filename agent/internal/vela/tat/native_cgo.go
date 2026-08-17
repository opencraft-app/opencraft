//go:build vela_tat_cgo && cgo && ((darwin && arm64) || (linux && amd64))

package tat

/*
#cgo CFLAGS: -I${SRCDIR}/../../../native/tat-agent/include
#cgo LDFLAGS: ${SRCDIR}/../../../native/tat-agent/target/release/libvela_tat.a
#cgo darwin,arm64 LDFLAGS: -framework Security -framework CoreFoundation -framework IOKit
#cgo darwin,arm64 LDFLAGS: -framework SystemConfiguration -framework Foundation
#cgo darwin,arm64 LDFLAGS: -liconv
#cgo linux,amd64 LDFLAGS: -ldl -lpthread -lm -lrt -lutil
#include <stdlib.h>
#include "vela_tat.h"

extern uint64_t velaGoTATActivityAcquire(uint32_t kind);
extern void velaGoTATActivityRelease(uint64_t token);

static uint64_t vela_activity_acquire_bridge(uint32_t kind) {
    return velaGoTATActivityAcquire(kind);
}

static void vela_activity_release_bridge(uint64_t token) {
    velaGoTATActivityRelease(token);
}

static int vela_configure_activity_callbacks(void) {
    return vela_tat_set_activity_callbacks(
        vela_activity_acquire_bridge,
        vela_activity_release_bridge);
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	goruntime "runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"velachat/agent/internal/vela/activitygate"
)

var tatActivityCallbacks struct {
	mu     sync.Mutex
	gate   *activitygate.Gate
	leases map[uint64]*activitygate.Lease
	next   atomic.Uint64
}

type cgoBridge struct{}

func (cgoBridge) configureActivityGate(gate *activitygate.Gate) error {
	if gate == nil {
		return ErrInvalidConfig
	}
	tatActivityCallbacks.mu.Lock()
	if tatActivityCallbacks.gate != nil {
		tatActivityCallbacks.mu.Unlock()
		return ErrInvalidConfig
	}
	tatActivityCallbacks.gate = gate
	tatActivityCallbacks.leases = make(map[uint64]*activitygate.Lease)
	tatActivityCallbacks.mu.Unlock()
	if code := C.vela_configure_activity_callbacks(); code != 0 {
		tatActivityCallbacks.mu.Lock()
		tatActivityCallbacks.gate = nil
		tatActivityCallbacks.leases = nil
		tatActivityCallbacks.mu.Unlock()
		return nativeError("configure activity callbacks", int(code))
	}
	return nil
}

//export velaGoTATActivityAcquire
func velaGoTATActivityAcquire(kind C.uint32_t) C.uint64_t {
	activityKind := activitygate.TATTask
	if uint32(kind) == 2 {
		activityKind = activitygate.TerminalSession
	} else if uint32(kind) != 1 {
		return 0
	}
	tatActivityCallbacks.mu.Lock()
	gate := tatActivityCallbacks.gate
	tatActivityCallbacks.mu.Unlock()
	if gate == nil {
		return 0
	}
	lease, err := gate.Acquire(context.Background(), activityKind)
	if err != nil {
		return 0
	}
	token := tatActivityCallbacks.next.Add(1)
	if token == 0 {
		token = tatActivityCallbacks.next.Add(1)
	}
	tatActivityCallbacks.mu.Lock()
	if tatActivityCallbacks.gate != gate {
		tatActivityCallbacks.mu.Unlock()
		lease.Release()
		return 0
	}
	tatActivityCallbacks.leases[token] = lease
	tatActivityCallbacks.mu.Unlock()
	return C.uint64_t(token)
}

//export velaGoTATActivityRelease
func velaGoTATActivityRelease(token C.uint64_t) {
	tatActivityCallbacks.mu.Lock()
	lease := tatActivityCallbacks.leases[uint64(token)]
	delete(tatActivityCallbacks.leases, uint64(token))
	tatActivityCallbacks.mu.Unlock()
	if lease != nil {
		lease.Release()
	}
}

func defaultNativeBridge() nativeBridge {
	return cgoBridge{}
}

func (cgoBridge) register(
	stateRoot string,
	region string,
	registerCodeID string,
	registerCodeValue string,
	tagsJSON string,
) error {
	root := C.CString(stateRoot)
	defer C.free(unsafe.Pointer(root))
	nativeRegion := C.CString(region)
	defer C.free(unsafe.Pointer(nativeRegion))
	codeID := C.CString(registerCodeID)
	defer C.free(unsafe.Pointer(codeID))
	codeValue := C.CString(registerCodeValue)
	defer C.free(unsafe.Pointer(codeValue))
	tags := C.CString(tagsJSON)
	defer C.free(unsafe.Pointer(tags))

	code := C.vela_tat_register(
		root,
		nativeRegion,
		codeID,
		codeValue,
		tags,
	)
	if code != 0 {
		return nativeError("register", int(code))
	}
	return nil
}

func (cgoBridge) start(stateRoot string) (nativeHandle, error) {
	root := C.CString(stateRoot)
	defer C.free(unsafe.Pointer(root))
	var handle *C.VelaTatHandle
	code := C.vela_tat_start(root, &handle)
	if code != 0 {
		return nil, nativeError("start", int(code))
	}
	if handle == nil {
		return nil, errors.New("TAT start returned an empty handle")
	}
	return &cgoHandle{value: handle}, nil
}

func (cgoBridge) inspect(stateRoot string) (Identity, error) {
	root := C.CString(stateRoot)
	defer C.free(unsafe.Pointer(root))
	region := make([]byte, 256)
	instanceID := make([]byte, 1024)
	code := C.vela_tat_inspect_identity(
		root,
		(*C.char)(unsafe.Pointer(&region[0])), C.size_t(len(region)),
		(*C.char)(unsafe.Pointer(&instanceID[0])), C.size_t(len(instanceID)),
	)
	if code != 0 {
		return Identity{}, nativeError("inspect identity", int(code))
	}
	goruntime.KeepAlive(region)
	goruntime.KeepAlive(instanceID)
	return Identity{
		Region:     C.GoString((*C.char)(unsafe.Pointer(&region[0]))),
		InstanceID: C.GoString((*C.char)(unsafe.Pointer(&instanceID[0]))),
	}, nil
}

type cgoHandle struct {
	value *C.VelaTatHandle
}

func (h *cgoHandle) close() error {
	if h.value == nil {
		return nil
	}
	code := C.vela_tat_close(h.value)
	goruntime.KeepAlive(h)
	if code != 0 {
		return nativeError("close", int(code))
	}
	h.value = nil
	return nil
}

func nativeError(operation string, code int) error {
	required := int(C.vela_tat_last_error(nil, 0))
	if required < 2 {
		return fmt.Errorf("TAT %s failed with code %d", operation, code)
	}
	if required > 64*1024 {
		required = 64 * 1024
	}
	buffer := make([]byte, required)
	C.vela_tat_last_error(
		(*C.char)(unsafe.Pointer(&buffer[0])),
		C.size_t(len(buffer)),
	)
	goruntime.KeepAlive(buffer)
	message := C.GoString((*C.char)(unsafe.Pointer(&buffer[0])))
	if message == "" {
		return fmt.Errorf("TAT %s failed with code %d", operation, code)
	}
	return fmt.Errorf("TAT %s failed with code %d: %s", operation, code, message)
}
