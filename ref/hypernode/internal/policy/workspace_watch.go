package policy

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const workspaceWatchQueueLimit = 4096

// workspaceWatch bridges Linux inotify into a bounded, pull-based queue. The
// QuickJS policy drains the queue while holding its VM lock; the watcher goroutine
// never calls JavaScript directly.
type workspaceWatch struct {
	fd           int
	stopFD       int
	mountPath    string
	logicalRoot  string
	physicalRoot string
	notify       func()

	mu       sync.Mutex
	closed   bool
	wdToPath map[int]string
	pathToWD map[string]int
	pending  []workspaceWatchEvent
	seen     map[string]struct{}
	ready    bool
	failure  string
	done     chan struct{}
	close    sync.Once
}

type workspaceWatchEvent struct {
	EventType string `json:"eventType"`
	Path      string `json:"path"`
}

func newWorkspaceWatch(logicalRoot, mountPath string, notify func()) (*workspaceWatch, error) {
	logicalRoot, err := workspaceLogicalPath(logicalRoot)
	if err != nil {
		return nil, err
	}
	mountPath = filepath.Clean(mountPath)
	mountInfo, err := os.Lstat(mountPath)
	if err != nil {
		return nil, fmt.Errorf("inspect workspace mount: %w", err)
	}
	if mountInfo.Mode()&os.ModeSymlink != 0 || !mountInfo.IsDir() {
		return nil, fmt.Errorf("workspace mount is not a directory: %s", mountPath)
	}
	relative := strings.TrimPrefix(logicalRoot, "/workspace")
	physicalRoot := filepath.Join(mountPath, filepath.FromSlash(strings.TrimPrefix(relative, "/")))
	if physicalRoot != mountPath && !strings.HasPrefix(physicalRoot, mountPath+string(filepath.Separator)) {
		return nil, fmt.Errorf("workspace watch escapes mount: %s", logicalRoot)
	}
	fd, err := unix.InotifyInit1(unix.IN_NONBLOCK | unix.IN_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("initialize workspace inotify: %w", err)
	}
	stopFD, err := unix.Eventfd(0, unix.EFD_NONBLOCK|unix.EFD_CLOEXEC)
	if err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("initialize workspace watch stop event: %w", err)
	}
	watch := &workspaceWatch{
		fd: fd, stopFD: stopFD, mountPath: mountPath, logicalRoot: logicalRoot,
		physicalRoot: physicalRoot, notify: notify, wdToPath: make(map[int]string),
		pathToWD: make(map[string]int), seen: make(map[string]struct{}), done: make(chan struct{}),
	}
	// Install exactly one anchor before returning. This is constant work and
	// closes the race between API registration and the asynchronous recursive
	// scan: direct creates are queued by inotify while the worker discovers the
	// remaining tree.
	if err := watch.installAnchor(); err != nil {
		_ = unix.Close(fd)
		_ = unix.Close(stopFD)
		return nil, err
	}
	go watch.run()
	return watch, nil
}

func (w *workspaceWatch) installAnchor() error {
	anchor := w.physicalRoot
	for {
		info, err := os.Lstat(anchor)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("refusing workspace watch through symlinks: %s", w.logicalRoot)
			}
			if !info.IsDir() {
				anchor = filepath.Dir(anchor)
				continue
			}
			resolved, resolveErr := filepath.EvalSymlinks(anchor)
			if resolveErr != nil || resolved != anchor {
				return fmt.Errorf("refusing workspace watch through symlinks: %s", w.logicalRoot)
			}
			return w.addDirectory(anchor)
		}
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect workspace watch anchor: %w", err)
		}
		parent := filepath.Dir(anchor)
		if parent == anchor || (anchor != w.mountPath && !strings.HasPrefix(anchor, w.mountPath+string(filepath.Separator))) {
			return fmt.Errorf("workspace mount is unavailable: %s", w.mountPath)
		}
		anchor = parent
	}
}

func (w *workspaceWatch) installInitial() error {
	info, err := os.Lstat(w.physicalRoot)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink workspace watch: %s", w.logicalRoot)
		}
		resolved, resolveErr := filepath.EvalSymlinks(w.physicalRoot)
		if resolveErr != nil || resolved != w.physicalRoot {
			return fmt.Errorf("refusing workspace watch through symlinks: %s", w.logicalRoot)
		}
		if info.IsDir() {
			return w.addTree(w.physicalRoot, false)
		}
		return w.addDirectory(filepath.Dir(w.physicalRoot))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect workspace watch path: %w", err)
	}
	ancestor := filepath.Dir(w.physicalRoot)
	for {
		info, statErr := os.Lstat(ancestor)
		if statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return fmt.Errorf("workspace watch ancestor is not a directory: %s", ancestor)
			}
			resolved, resolveErr := filepath.EvalSymlinks(ancestor)
			if resolveErr != nil || resolved != ancestor {
				return fmt.Errorf("refusing workspace watch through symlinks: %s", w.logicalRoot)
			}
			return w.addDirectory(ancestor)
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("inspect workspace watch ancestor: %w", statErr)
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor || (ancestor != w.mountPath && !strings.HasPrefix(ancestor, w.mountPath+string(filepath.Separator))) {
			return fmt.Errorf("workspace mount is unavailable: %s", w.mountPath)
		}
		ancestor = parent
	}
}

func (w *workspaceWatch) addTree(root string, reportExisting bool) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if err := w.addDirectory(path); err != nil {
				return err
			}
			if reportExisting && path != root && w.changeRelevant(path) {
				w.enqueue("rename", w.toLogical(path))
			}
			return nil
		}
		if reportExisting && w.changeRelevant(path) {
			w.enqueue("rename", w.toLogical(path))
		}
		return nil
	})
}

func (w *workspaceWatch) addDirectory(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return os.ErrClosed
	}
	path = filepath.Clean(path)
	if _, exists := w.pathToWD[path]; exists {
		return nil
	}
	mask := uint32(unix.IN_ATTRIB | unix.IN_CLOSE_WRITE | unix.IN_CREATE | unix.IN_DELETE |
		unix.IN_DELETE_SELF | unix.IN_MODIFY | unix.IN_MOVE_SELF | unix.IN_MOVED_FROM |
		unix.IN_MOVED_TO | unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW)
	wd, err := unix.InotifyAddWatch(w.fd, path, mask)
	if err != nil {
		return fmt.Errorf("watch workspace directory %s: %w", path, err)
	}
	w.wdToPath[wd] = path
	w.pathToWD[path] = wd
	return nil
}

func (w *workspaceWatch) run() {
	defer close(w.done)
	defer unix.Close(w.fd)
	defer unix.Close(w.stopFD)
	if err := w.installInitial(); err != nil {
		w.mu.Lock()
		w.failure = err.Error()
		w.mu.Unlock()
		w.notify()
		return
	}
	w.mu.Lock()
	w.ready = true
	w.mu.Unlock()
	w.notify()
	buffer := make([]byte, 64*1024)
	pollFDs := []unix.PollFd{
		{Fd: int32(w.fd), Events: unix.POLLIN},
		{Fd: int32(w.stopFD), Events: unix.POLLIN},
	}
	for {
		_, err := unix.Poll(pollFDs, -1)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return
		}
		if pollFDs[1].Revents&unix.POLLIN != 0 {
			return
		}
		if pollFDs[0].Revents&unix.POLLIN == 0 {
			continue
		}
		for {
			length, readErr := unix.Read(w.fd, buffer)
			if errors.Is(readErr, unix.EAGAIN) || errors.Is(readErr, unix.EWOULDBLOCK) {
				break
			}
			if readErr != nil || length <= 0 {
				return
			}
			w.consume(buffer[:length])
		}
	}
}

func (w *workspaceWatch) consume(buffer []byte) {
	const eventSize = int(unsafe.Sizeof(unix.InotifyEvent{}))
	for offset := 0; offset+eventSize <= len(buffer); {
		event := (*unix.InotifyEvent)(unsafe.Pointer(&buffer[offset]))
		next := offset + eventSize + int(event.Len)
		if next > len(buffer) {
			break
		}
		name := strings.TrimRight(string(buffer[offset+eventSize:next]), "\x00")
		offset = next
		if event.Mask&unix.IN_Q_OVERFLOW != 0 {
			w.enqueue("rename", w.logicalRoot)
			continue
		}
		w.mu.Lock()
		directory := w.wdToPath[int(event.Wd)]
		w.mu.Unlock()
		if directory == "" {
			continue
		}
		changed := directory
		if name != "" {
			changed = filepath.Join(directory, name)
		}
		isDirectory := event.Mask&unix.IN_ISDIR != 0
		if isDirectory && event.Mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 && w.traversalRelevant(changed) {
			// A checkout can populate a directory before this goroutine handles
			// its create event. Report the contents found while installing the
			// recursive watches so that the race cannot lose those changes.
			_ = w.addTree(changed, true)
		}
		if w.changeRelevant(changed) {
			eventType := "change"
			if event.Mask&(unix.IN_CREATE|unix.IN_DELETE|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF|unix.IN_MOVED_FROM|unix.IN_MOVED_TO) != 0 {
				eventType = "rename"
			}
			w.enqueue(eventType, w.toLogical(changed))
		}
		if event.Mask&unix.IN_IGNORED != 0 {
			w.removeDescriptor(int(event.Wd))
		} else if isDirectory && event.Mask&(unix.IN_DELETE|unix.IN_MOVED_FROM) != 0 {
			w.removeTree(changed)
		} else if event.Mask&(unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0 {
			w.removeTree(directory)
		}
	}
}

func (w *workspaceWatch) traversalRelevant(path string) bool {
	path = filepath.Clean(path)
	return path == w.physicalRoot || strings.HasPrefix(path, w.physicalRoot+string(filepath.Separator)) ||
		strings.HasPrefix(w.physicalRoot, path+string(filepath.Separator))
}

func (w *workspaceWatch) changeRelevant(path string) bool {
	path = filepath.Clean(path)
	return path == w.physicalRoot || strings.HasPrefix(path, w.physicalRoot+string(filepath.Separator))
}

func (w *workspaceWatch) toLogical(physical string) string {
	relative, err := filepath.Rel(w.mountPath, physical)
	if err != nil || relative == "." {
		return "/workspace"
	}
	return "/workspace/" + filepath.ToSlash(relative)
}

func (w *workspaceWatch) enqueue(eventType, path string) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if len(w.pending) >= workspaceWatchQueueLimit {
		w.pending = []workspaceWatchEvent{{EventType: "rename", Path: w.logicalRoot}}
		w.seen = map[string]struct{}{"rename\x00" + w.logicalRoot: {}}
		w.mu.Unlock()
		w.notify()
		return
	}
	key := eventType + "\x00" + path
	if _, exists := w.seen[key]; exists {
		w.mu.Unlock()
		return
	}
	w.seen[key] = struct{}{}
	w.pending = append(w.pending, workspaceWatchEvent{EventType: eventType, Path: path})
	w.mu.Unlock()
	w.notify()
}

func (w *workspaceWatch) drain() []string {
	events, _, _, _ := w.drainState()
	result := make([]string, 0, len(events))
	for _, event := range events {
		result = append(result, event.Path)
	}
	return result
}

func (w *workspaceWatch) drainState() ([]workspaceWatchEvent, bool, string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := append([]workspaceWatchEvent(nil), w.pending...)
	w.pending = nil
	w.seen = make(map[string]struct{})
	return result, w.ready, w.failure, w.closed
}

func (w *workspaceWatch) removeDescriptor(wd int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path := w.wdToPath[wd]
	delete(w.wdToPath, wd)
	delete(w.pathToWD, path)
}

func (w *workspaceWatch) removeTree(root string) {
	w.mu.Lock()
	descriptors := make([]int, 0)
	for path, wd := range w.pathToWD {
		if path == root || strings.HasPrefix(path, root+string(filepath.Separator)) {
			descriptors = append(descriptors, wd)
			delete(w.pathToWD, path)
			delete(w.wdToPath, wd)
		}
	}
	w.mu.Unlock()
	for _, wd := range descriptors {
		_, _ = unix.InotifyRmWatch(w.fd, uint32(wd))
	}
}

func (w *workspaceWatch) Close() {
	w.close.Do(func() {
		w.mu.Lock()
		w.closed = true
		w.mu.Unlock()
		var value uint64 = 1
		bytes := (*[8]byte)(unsafe.Pointer(&value))[:]
		_, _ = unix.Write(w.stopFD, bytes)
		select {
		case <-w.done:
		case <-time.After(time.Second):
		}
	})
}
