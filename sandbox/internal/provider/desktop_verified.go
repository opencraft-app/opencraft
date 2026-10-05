package provider

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

// Root-only material is fetched over the backend's existing authenticated TAT
// command API. Never return, log or persist its output in an attachment DTO.
const desktopObserverKeyCommand = `sudo -n /usr/bin/python3 - <<'OBSERVER_KEY'
import json, os, stat
directory = '/run/opencraft-desktop-observer'
d = os.lstat(directory)
if not stat.S_ISDIR(d.st_mode) or d.st_uid != 0 or d.st_mode & 0o077:
    raise RuntimeError('observer unavailable')
fd = os.open(directory + '/key', os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as source:
    s = os.fstat(source.fileno())
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o077 or s.st_size != 32:
        raise RuntimeError('observer unavailable')
    key = source.read(33)
if len(key) != 32:
    raise RuntimeError('observer unavailable')
print(json.dumps({'version': 1, 'key': key.hex()}, separators=(',', ':')))
OBSERVER_KEY`

var errVerifiedObserver = errors.New("verified desktop observation unavailable")

// DesktopObserverRuntime is verified by the native peer, not a preparation job.
// It contains no viewing privilege or vendor credential. The caller still owns
// product authorization, resource binding, expiration and revocation.
type DesktopObserverRuntime struct {
	Incarnation string
}

func (p *TencentCloudProvider) desktopObserverKey(ctx context.Context, region, instanceID string) ([]byte, error) {
	var runner CommandRunner = p
	if p.desktopObserverCommands != nil {
		runner = p.desktopObserverCommands
	}
	inv, err := runner.RunCommand(ctx, region, instanceID, desktopObserverKeyCommand)
	if err != nil || ctx.Err() != nil || inv.InvocationID == "" || inv.InstanceID != instanceID || inv.Region != region {
		return nil, errVerifiedObserver
	}
	for {
		result, err := runner.GetCommandInvocation(ctx, region, inv.InvocationID, instanceID)
		if err != nil || ctx.Err() != nil || result.InvocationID != inv.InvocationID || result.InstanceID != instanceID || result.Region != region {
			return nil, errVerifiedObserver
		}
		switch result.Status {
		case "SUCCESS":
			if result.ExitCode != 0 || result.Dropped != 0 || len(result.Output) > 256 {
				return nil, errVerifiedObserver
			}
			var dto struct {
				Version int    `json:"version"`
				Key     string `json:"key"`
			}
			if decodeObserverJSON([]byte(result.Output), &dto) != nil || dto.Version != 1 || !observerHex(dto.Key) {
				return nil, errVerifiedObserver
			}
			key, err := hex.DecodeString(dto.Key)
			if err != nil || len(key) != 32 {
				return nil, errVerifiedObserver
			}
			return key, nil
		case "PENDING", "RUNNING":
			select {
			case <-ctx.Done():
				return nil, errVerifiedObserver
			case <-time.After(200 * time.Millisecond):
			}
		default:
			return nil, errVerifiedObserver
		}
	}
}

func decodeObserverJSON(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errVerifiedObserver
	}
	return nil
}
func observerHex(value string) bool {
	return len(value) == 64 && strings.IndexFunc(value, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) == -1
}

type verifiedObserverStream struct {
	io.ReadWriteCloser
	reader *bufio.Reader
}

func (s *verifiedObserverStream) Read(data []byte) (int, error) { return s.reader.Read(data) }

// InspectDesktopObserver opens and closes a separate verified observer. No
// desktop startup, renewal or control is implied by inspecting it.
func (p *TencentCloudProvider) InspectDesktopObserver(ctx context.Context, region, instanceID string) (DesktopObserverRuntime, error) {
	stream, runtime, err := p.openVerifiedDesktopObserver(ctx, ctx, region, instanceID, "")
	if stream != nil {
		_ = stream.Close()
	}
	return runtime, err
}

// OpenVerifiedDesktopObserver requires the previously inspected physical
// incarnation. Fresh nonce + root-key MAC prevents a replaced loopback listener
// replaying an old runtime header. Read-only enforcement remains native x11vnc.
func (p *TencentCloudProvider) OpenVerifiedDesktopObserver(opening, lifetime context.Context, region, instanceID, incarnation string) (io.ReadWriteCloser, error) {
	if !observerHex(incarnation) {
		return nil, errVerifiedObserver
	}
	stream, _, err := p.openVerifiedDesktopObserver(opening, lifetime, region, instanceID, incarnation)
	return stream, err
}
func (p *TencentCloudProvider) openVerifiedDesktopObserver(parent, lifetime context.Context, region, instanceID, expected string) (io.ReadWriteCloser, DesktopObserverRuntime, error) {
	if parent == nil || lifetime == nil {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	opening, cancel := context.WithTimeout(parent, 15*time.Second)
	stopLife := context.AfterFunc(lifetime, cancel)
	defer func() { stopLife(); cancel() }()
	region, instanceID = p.resolveRegion(region), strings.TrimSpace(instanceID)
	if !tencentRegionPattern.MatchString(region) || instanceID == "" {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	key, err := p.desktopObserverKey(opening, region, instanceID)
	if err != nil {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	raw, err := p.openDesktopObserver(opening, lifetime, region, instanceID, "5902")
	if err != nil {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	stop := context.AfterFunc(opening, func() { _ = raw.Close() })
	ok := false
	defer func() {
		stop()
		if !ok {
			_ = raw.Close()
		}
	}()
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	nonce := hex.EncodeToString(nonceBytes)
	challenge, _ := json.Marshal(struct {
		Nonce string `json:"nonce"`
	}{nonce})
	if _, err := raw.Write(append(challenge, '\n')); err != nil {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	reader := bufio.NewReaderSize(raw, 1024)
	header, err := reader.ReadSlice('\n')
	if err != nil || len(header) > 512 {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	var proof struct {
		Protocol    string `json:"protocol"`
		Version     int    `json:"version"`
		ReadOnly    bool   `json:"readOnly"`
		Incarnation string `json:"incarnation"`
		Nonce       string `json:"nonce"`
		MAC         string `json:"mac"`
	}
	if decodeObserverJSON(header, &proof) != nil || proof.Protocol != "opencraft-desktop-observer" || proof.Version != 1 ||
		!proof.ReadOnly || proof.Nonce != nonce || !observerHex(proof.Incarnation) || !observerHex(proof.MAC) ||
		(expected != "" && proof.Incarnation != expected) {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("opencraft-desktop-observer/v1\x00" + nonce + "\x00" + proof.Incarnation))
	actual, _ := hex.DecodeString(proof.MAC)
	if !hmac.Equal(mac.Sum(nil), actual) || opening.Err() != nil || lifetime.Err() != nil || !stop() {
		return nil, DesktopObserverRuntime{}, errVerifiedObserver
	}
	ok = true
	return &verifiedObserverStream{ReadWriteCloser: raw, reader: reader}, DesktopObserverRuntime{Incarnation: proof.Incarnation}, nil
}
