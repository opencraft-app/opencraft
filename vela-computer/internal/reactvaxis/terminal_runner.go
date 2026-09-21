package reactvaxis

import (
	"context"
	"fmt"
	"math"
	"time"

	"go.rockorager.dev/vaxis"
	"go.rockorager.dev/vaxis/ui"
)

const (
	// DefaultKittyKeyboardFlags keeps Kitty's unambiguous key encoding,
	// event reporting, and alternate key codes while leaving text-producing
	// keys on the terminal's UTF-8 path. iTerm2 3.5.14 drops macOS IME commit
	// text when ReportAllKeys is enabled.
	DefaultKittyKeyboardFlags vaxis.CSIuBitMask = vaxis.CSIuDisambiguate |
		vaxis.CSIuReportEvents |
		vaxis.CSIuAlternateKeys

	// FullKittyKeyboardFlags is retained for terminal regression testing.
	FullKittyKeyboardFlags vaxis.CSIuBitMask = DefaultKittyKeyboardFlags |
		vaxis.CSIuAllKeys |
		vaxis.CSIuAssociatedText
)

func runTerminal(root ui.Widget, kittyFlags vaxis.CSIuBitMask, options ...ui.Option) error {
	if kittyFlags <= 0 || kittyFlags > FullKittyKeyboardFlags {
		return fmt.Errorf("Kitty keyboard flags must be between 1 and %d, got %d", FullKittyKeyboardFlags, kittyFlags)
	}
	vx, err := vaxis.New(vaxis.Options{
		EnableSGRPixels: true,
		CSIuBitMask:     kittyFlags,
	})
	if err != nil {
		return err
	}
	backend := terminalBackend{vx: vx}
	defer func() { _ = backend.Close() }()

	appOptions := append([]ui.Option{ui.WithThemeSet(ui.DefaultThemeSet())}, options...)
	app := ui.NewApp(root, appOptions...)
	queryContext, cancelQuery := context.WithTimeout(context.Background(), 200*time.Millisecond)
	foreground := vx.QueryForegroundContext(queryContext)
	background := vx.QueryBackgroundContext(queryContext)
	cancelQuery()
	if mode, ok := detectTerminalThemeMode(foreground, background); ok {
		app.SetThemeMode(mode)
	}
	runner := ui.NewRunner(app, backend, ui.NewFrameScheduler(ui.DefaultFrameInterval))
	frameTimer := time.NewTimer(time.Hour)
	if !frameTimer.Stop() {
		<-frameTimer.C
	}
	defer frameTimer.Stop()

	schedule := func() {
		due, ok := runner.NextFrame()
		if !ok {
			return
		}
		if !frameTimer.Stop() {
			select {
			case <-frameTimer.C:
			default:
			}
		}
		delay := time.Until(due)
		if delay < 0 {
			delay = 0
		}
		frameTimer.Reset(delay)
	}

	runner.Start(time.Now())
	schedule()
	events := backend.Events()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return nil
			}
			if resize, ok := event.(vaxis.Resize); ok {
				backend.Resize(resize)
			}
			runner.HandleEvent(event, time.Now())
			if runner.Done() {
				return nil
			}
			schedule()
		case <-frameTimer.C:
			if err := runner.HandleFrame(time.Now()); err != nil {
				return err
			}
			schedule()
		}
	}
}

func detectTerminalThemeMode(foreground, background vaxis.Color) (ui.ThemeMode, bool) {
	foregroundRGB := foreground.Params()
	backgroundRGB := background.Params()
	if len(foregroundRGB) != 3 || len(backgroundRGB) != 3 {
		return ui.DarkTheme, false
	}
	if terminalColorLuminance(backgroundRGB) > terminalColorLuminance(foregroundRGB) {
		return ui.LightTheme, true
	}
	return ui.DarkTheme, true
}

func terminalColorLuminance(rgb []uint8) float64 {
	linear := func(channel uint8) float64 {
		value := float64(channel) / 255
		if value <= 0.04045 {
			return value / 12.92
		}
		return math.Pow((value+0.055)/1.055, 2.4)
	}
	return 0.2126*linear(rgb[0]) + 0.7152*linear(rgb[1]) + 0.0722*linear(rgb[2])
}

type terminalBackend struct{ vx *vaxis.Vaxis }

func (backend terminalBackend) Events() <-chan ui.Event { return backend.vx.Events() }

func (backend terminalBackend) Size() ui.Size {
	window := backend.vx.Window()
	return ui.Size{Width: window.Width, Height: window.Height}
}

func (backend terminalBackend) Resize(size vaxis.Resize) { backend.vx.Resize(size) }

func (backend terminalBackend) Render(painter *ui.Painter) error {
	window := backend.vx.Window()
	window.Clear()
	size := painter.Size()
	for row := 0; row < size.Height; row++ {
		for column := 0; column < size.Width; column++ {
			window.SetCell(column, row, painter.Cell(column, row))
		}
	}
	if cursor, ok := painter.Cursor(); ok {
		backend.vx.ShowCursor(cursor.Col, cursor.Row, cursor.Shape)
	} else {
		backend.vx.HideCursor()
	}
	backend.vx.Render()
	return nil
}

func (backend terminalBackend) Dispatch(function func()) {
	backend.vx.PostEvent(vaxis.SyncFunc(function))
}

func (backend terminalBackend) SetMouseShape(shape ui.MouseShape) {
	backend.vx.SetMouseShape(shape)
}

func (backend terminalBackend) Close() error {
	backend.vx.Close()
	return nil
}
