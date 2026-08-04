package reactvaxis

import (
	"testing"

	"go.rockorager.dev/vaxis"
	"go.rockorager.dev/vaxis/ui"
)

func TestDetectTerminalThemeModeFromForegroundAndBackground(t *testing.T) {
	tests := []struct {
		name       string
		foreground vaxis.Color
		background vaxis.Color
		want       ui.ThemeMode
		ok         bool
	}{
		{name: "light terminal", foreground: vaxis.RGBColor(20, 20, 20), background: vaxis.RGBColor(250, 250, 250), want: ui.LightTheme, ok: true},
		{name: "dark terminal", foreground: vaxis.RGBColor(240, 240, 240), background: vaxis.RGBColor(10, 10, 10), want: ui.DarkTheme, ok: true},
		{name: "unreported colors", want: ui.DarkTheme, ok: false},
		{name: "indexed colors", foreground: vaxis.ColorWhite, background: vaxis.ColorBlack, want: ui.DarkTheme, ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := detectTerminalThemeMode(test.foreground, test.background)
			if got != test.want || ok != test.ok {
				t.Fatalf("detectTerminalThemeMode() = %v,%v, want %v,%v", got, ok, test.want, test.ok)
			}
		})
	}
}
