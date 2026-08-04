package reactvaxis

import (
	"fmt"
	"strings"
)

// NativeStyle is the deliberately small layout vocabulary crossing the
// JavaScript/Go boundary in this spike. It is not a copy of CSS.
type NativeStyle struct {
	Direction  string `json:"direction,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	MinWidth   int    `json:"minWidth,omitempty"`
	MaxWidth   int    `json:"maxWidth,omitempty"`
	MinHeight  int    `json:"minHeight,omitempty"`
	MaxHeight  int    `json:"maxHeight,omitempty"`
	Padding    int    `json:"padding,omitempty"` // reactvaxis/v1 compatibility
	PaddingX   int    `json:"paddingX,omitempty"`
	PaddingY   int    `json:"paddingY,omitempty"`
	Gap        int    `json:"gap,omitempty"`
	CrossAlign string `json:"crossAlign,omitempty"`
	MainAlign  string `json:"mainAlign,omitempty"`
	Border     bool   `json:"border,omitempty"`
	Flex       int    `json:"flex,omitempty"`
	Surface    string `json:"surface,omitempty"`
}

// NativeSegment is the pure-data form of one Vaxis segmented option.
type NativeSegment struct {
	Value    string `json:"value"`
	Label    string `json:"label"`
	Disabled bool   `json:"disabled,omitempty"`
}

// NativeValueKind discriminates scalar values carried by NativeEvent.
type NativeValueKind string

const (
	NativeBoolValue   NativeValueKind = "bool"
	NativeStringValue NativeValueKind = "string"
)

// NativeNode is the pure-data tree emitted once per React commit.
type NativeNode struct {
	Type                string          `json:"type"`
	TestID              string          `json:"testId,omitempty"`
	Text                string          `json:"text,omitempty"`
	Value               string          `json:"value,omitempty"`
	Placeholder         string          `json:"placeholder,omitempty"`
	AutoFocus           bool            `json:"autoFocus,omitempty"`
	SecureTextEntry     bool            `json:"secureTextEntry,omitempty"`
	Checked             bool            `json:"checked,omitempty"`
	Disabled            bool            `json:"disabled,omitempty"`
	Label               string          `json:"label,omitempty"`
	GroupValue          string          `json:"groupValue,omitempty"`
	OnPress             string          `json:"onPress,omitempty"`
	OnChangeText        string          `json:"onChangeText,omitempty"`
	OnValueChange       string          `json:"onValueChange,omitempty"`
	OnDismiss           string          `json:"onDismiss,omitempty"`
	OnBack              string          `json:"onBack,omitempty"`
	Segments            []NativeSegment `json:"segments,omitempty"`
	Progress            float64         `json:"progress,omitempty"`
	Width               int             `json:"width,omitempty"`
	Title               string          `json:"title,omitempty"`
	Subtitle            string          `json:"subtitle,omitempty"`
	Leading             string          `json:"leading,omitempty"`
	Trailing            string          `json:"trailing,omitempty"`
	Selected            bool            `json:"selected,omitempty"`
	Modal               bool            `json:"modal,omitempty"`
	Alignment           string          `json:"alignment,omitempty"`
	ActiveIndex         int             `json:"activeIndex,omitempty"`
	CanGoBack           bool            `json:"canGoBack,omitempty"`
	ItemExtent          int             `json:"itemExtent,omitempty"`
	EstimatedItemExtent int             `json:"estimatedItemExtent,omitempty"`
	Overscan            int             `json:"overscan,omitempty"`
	ActiveRouteKey      string          `json:"activeRouteKey,omitempty"`
	LayoutVersion       string          `json:"layoutVersion,omitempty"`
	// MostRecentEventCount acknowledges the newest native text change that
	// the React value includes. Older controlled commits must not overwrite a
	// newer native buffer or move its cursor.
	MostRecentEventCount int           `json:"mostRecentEventCount,omitempty"`
	MaxLines             int           `json:"maxLines,omitempty"`
	Style                NativeStyle   `json:"style,omitempty"`
	ContentStyle         NativeStyle   `json:"contentStyle,omitempty"`
	Children             []*NativeNode `json:"children,omitempty"`
}

// Find returns the node with testID, depth first.
func (n *NativeNode) Find(testID string) *NativeNode {
	if n == nil {
		return nil
	}
	if n.TestID == testID {
		return n
	}
	for _, child := range n.Children {
		if found := child.Find(testID); found != nil {
			return found
		}
	}
	return nil
}

// MustFind is a compact assertion helper for the spike's contract tests.
func (n *NativeNode) MustFind(testID string) *NativeNode {
	if found := n.Find(testID); found != nil {
		return found
	}
	panic(fmt.Sprintf("NativeNode testID %q not found", testID))
}

// TextContent returns the text projected by this node and its descendants.
func (n *NativeNode) TextContent() string {
	if n == nil {
		return ""
	}
	if n.Text != "" {
		return n.Text
	}
	var value strings.Builder
	for _, child := range n.Children {
		value.WriteString(child.TextContent())
	}
	return value.String()
}

// NativeEvent is the only event envelope sent from Vaxis back to JavaScript.
type NativeEvent struct {
	HandlerID  string
	ValueKind  NativeValueKind
	Value      string
	BoolValue  bool
	Source     string
	EventCount int
}
