package reactvaxis

import (
	"strings"

	"go.rockorager.dev/vaxis/ui"
)

// HeadlessHarness renders the exact Vaxis ui tree into cells without opening a
// terminal. It is used for deterministic regression tests and snapshots.
type HeadlessHarness struct {
	app     *ui.App
	width   int
	height  int
	painter *ui.Painter
}

func NewHeadlessHarness(root ui.Widget, width, height int) *HeadlessHarness {
	harness := &HeadlessHarness{
		app:    ui.NewApp(root, ui.WithTheme(ui.DefaultTheme())),
		width:  width,
		height: height,
	}
	harness.pump()
	return harness
}

func (h *HeadlessHarness) Update(root ui.Widget) {
	h.app.UpdateRoot(root)
	h.pump()
}

func (h *HeadlessHarness) Send(event ui.Event) {
	h.app.Send(event)
	h.pump()
}

func (h *HeadlessHarness) Resize(width, height int) {
	h.width, h.height = width, height
	h.app.Send(ui.Resize{Cols: width, Rows: height})
	h.pump()
}

func (h *HeadlessHarness) Size() ui.Size {
	return ui.Size{Width: h.width, Height: h.height}
}

func (h *HeadlessHarness) ShouldQuit() bool { return h.app.ShouldQuit() }

func (h *HeadlessHarness) Contains(text string) bool {
	return strings.Contains(h.Snapshot(), text)
}

func (h *HeadlessHarness) Snapshot() string {
	if h.painter == nil {
		return ""
	}
	var output strings.Builder
	for row := 0; row < h.height; row++ {
		var line strings.Builder
		for col := 0; col < h.width; col++ {
			cell := h.painter.Cell(col, row)
			grapheme := cell.Grapheme
			if grapheme == "" && cell.Width == 0 {
				continue
			}
			if grapheme == "" {
				grapheme = " "
			}
			line.WriteString(grapheme)
		}
		output.WriteString(strings.TrimRight(line.String(), " "))
		if row+1 < h.height {
			output.WriteByte('\n')
		}
	}
	return output.String()
}

func (h *HeadlessHarness) pump() {
	size := ui.Size{Width: h.width, Height: h.height}
	h.app.Pump(size)
	// Lazy slivers publish their newly visible builder range during layout and
	// require the next pump to materialize those rows. A second settled pump is
	// harmless for eager widgets and mirrors the next scheduled terminal frame.
	h.app.Pump(size)
	h.painter = ui.NewPainter(size)
	h.app.Paint(h.painter)
}
