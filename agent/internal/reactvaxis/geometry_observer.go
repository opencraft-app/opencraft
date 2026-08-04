package reactvaxis

import (
	"sync"

	"go.rockorager.dev/vaxis/ui"
)

// GeometryObserver records the painted terminal-cell rectangle for nodes that
// expose a React Native testID. It is intentionally headless-only metadata: it
// never crosses into the JavaScript application contract.
type GeometryObserver struct {
	mu    sync.RWMutex
	rects map[string]ui.Rect
}

func NewGeometryObserver() *GeometryObserver {
	return &GeometryObserver{rects: make(map[string]ui.Rect)}
}

func (o *GeometryObserver) Rect(testID string) (ui.Rect, bool) {
	if o == nil {
		return ui.Rect{}, false
	}
	o.mu.RLock()
	defer o.mu.RUnlock()
	rect, ok := o.rects[testID]
	return rect, ok
}

func (o *GeometryObserver) record(testID string, rect ui.Rect) {
	if o == nil || testID == "" {
		return
	}
	o.mu.Lock()
	o.rects[testID] = rect
	o.mu.Unlock()
}

type geometryProbe struct {
	testID   string
	observer *GeometryObserver
	child    ui.Widget
}

func (w geometryProbe) WidgetChild() ui.Widget { return w.child }

func (w geometryProbe) CreateRenderObject(ui.BuildContext) ui.RenderObject {
	return &renderGeometryProbe{testID: w.testID, observer: w.observer}
}

func (w geometryProbe) UpdateRenderObject(_ ui.BuildContext, render ui.RenderObject) {
	probe := render.(*renderGeometryProbe)
	probe.testID = w.testID
	probe.observer = w.observer
}

type renderGeometryProbe struct {
	ui.SingleChildRenderObject
	testID   string
	observer *GeometryObserver
}

func (r *renderGeometryProbe) Layout(ctx ui.LayoutContext, constraints ui.Constraints) {
	child := r.Child()
	if child == nil {
		r.SetSize(constraints.Constrain(ui.Size{}))
		return
	}
	child.Layout(ctx, constraints)
	r.SetSize(constraints.Constrain(child.Base().Size()))
}

func (r *renderGeometryProbe) DryLayout(ctx ui.LayoutContext, constraints ui.Constraints) ui.Size {
	if child := r.Child(); child != nil {
		return constraints.Constrain(ui.DryLayout(ctx, child, constraints))
	}
	return constraints.Constrain(ui.Size{})
}

func (r *renderGeometryProbe) Paint(painter *ui.Painter, offset ui.Offset) {
	size := r.Size()
	r.observer.record(r.testID, ui.Rect{
		X: offset.X, Y: offset.Y, Width: size.Width, Height: size.Height,
	})
	if child := r.Child(); child != nil {
		child.Paint(painter, offset)
	}
}

func (r *renderGeometryProbe) HitTest(*ui.HitTestResult, ui.Point) bool { return false }

func (r *renderGeometryProbe) SelectionSize() ui.Size { return r.Size() }
