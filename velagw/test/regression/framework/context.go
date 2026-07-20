package framework

import (
	"context"
	"sync"
)

type cleanupAction struct {
	name   string
	run    func(context.Context) error
	safety bool
}

type RunContext struct {
	RunID     string
	Sanitizer *Sanitizer

	mu        sync.RWMutex
	values    map[string]any
	resources []ResourceRef
	cleanups  []cleanupAction
}

func NewRunContext(runID string, sanitizer *Sanitizer) *RunContext {
	if sanitizer == nil {
		sanitizer = NewSanitizer()
	}
	return &RunContext{RunID: runID, Sanitizer: sanitizer, values: map[string]any{}}
}

func (c *RunContext) Set(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
}

func (c *RunContext) Get(key string) (any, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	value, ok := c.values[key]
	return value, ok
}

func (c *RunContext) TrackResource(resource ResourceRef) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resources = append(c.resources, resource)
}

func (c *RunContext) Resources() []ResourceRef {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]ResourceRef(nil), c.resources...)
}

func (c *RunContext) DeferCleanup(name string, action func(context.Context) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cleanups = append(c.cleanups, cleanupAction{name: name, run: action})
}

func (c *RunContext) DeferSafetyCleanup(name string, action func(context.Context) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cleanups = append(c.cleanups, cleanupAction{name: name, run: action, safety: true})
}

func (c *RunContext) cleanupActions() []cleanupAction {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]cleanupAction(nil), c.cleanups...)
}
