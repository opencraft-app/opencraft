//go:build vela_tat_cgo && darwin && arm64 && cgo

package tat

/*
#cgo CFLAGS: -I${SRCDIR}/../../../native/tat-agent/include
#cgo LDFLAGS: ${SRCDIR}/../../../native/tat-agent/target/release/libvela_tat.a
#cgo LDFLAGS: -framework Security -framework CoreFoundation -framework IOKit
#cgo LDFLAGS: -framework SystemConfiguration -framework Foundation
#cgo LDFLAGS: -liconv
#include <stdlib.h>
#include "vela_tat.h"
*/
import "C"

import (
	"errors"
	"fmt"
	goruntime "runtime"
	"unsafe"
)

type cgoBridge struct{}

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
