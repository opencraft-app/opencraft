package common

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"testing"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"
	"github.com/stretchr/testify/require"
)

func webMFixture(t *testing.T, mutate func(*webm.Segment)) []byte {
	t.Helper()
	head := make([]byte, 19)
	copy(head, "OpusHead")
	head[8], head[9] = 1, 1
	binary.LittleEndian.PutUint16(head[10:], 312)
	binary.LittleEndian.PutUint32(head[12:], 48000)
	doc := struct {
		EBML    webm.EBMLHeader
		Segment webm.Segment `ebml:"Segment,size=unknown"`
	}{EBML: webm.EBMLHeader{EBMLVersion: 1, EBMLReadVersion: 1, EBMLMaxIDLength: 4, EBMLMaxSizeLength: 8, DocType: "webm", DocTypeVersion: 4, DocTypeReadVersion: 2}}
	doc.Segment.Info = webm.Info{TimecodeScale: 1_000_000}
	doc.Segment.Tracks.TrackEntry = []webm.TrackEntry{{TrackNumber: 1, TrackUID: 1, TrackType: 2, CodecID: "A_OPUS", CodecPrivate: head, Audio: &webm.Audio{SamplingFrequency: 48000, Channels: 1}}}
	doc.Segment.Cluster = []webm.Cluster{
		{Timecode: 0, SimpleBlock: []ebml.Block{{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: [][]byte{{0xf8, 0xff, 0xfe}}}}},
		{Timecode: 1000, SimpleBlock: []ebml.Block{{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: [][]byte{{0xf8, 0xff, 0xfe}}}}},
	}
	if mutate != nil {
		mutate(&doc.Segment)
	}
	var output bytes.Buffer
	require.NoError(t, ebml.Marshal(&doc, &output))
	return output.Bytes()
}

func TestWebMDurationWithoutDurationMetadata(t *testing.T) {
	audio := webMFixture(t, nil)
	duration, err := getWebMDuration(bytes.NewReader(audio))
	require.NoError(t, err)
	require.InDelta(t, 1.020, duration, 1e-8)
	// Misleading declared Duration cannot make billing underestimate blocks.
	audio = webMFixture(t, func(s *webm.Segment) { s.Info.Duration = 1 })
	duration, err = getWebMDuration(bytes.NewReader(audio))
	require.NoError(t, err)
	require.InDelta(t, 1.020, duration, 1e-8)
}

func TestWebMUnknownSizeClustersAndLacing(t *testing.T) {
	audio := webMFixture(t, func(s *webm.Segment) {
		s.Cluster[1].SimpleBlock[0].Lacing = ebml.LacingXiph
		s.Cluster[1].SimpleBlock[0].Data = [][]byte{{0xf8, 0xff, 0xfe}, {0xf8, 0xff, 0xfe}}
	})
	// Preserve framing width while turning each finite Cluster into a live,
	// unknown-size Cluster as produced by streaming MediaRecorder output.
	for offset := 0; offset < len(audio); {
		i := bytes.Index(audio[offset:], []byte{0x1f, 0x43, 0xb6, 0x75})
		if i < 0 {
			break
		}
		i += offset
		require.NotZero(t, audio[i+4]&0x80)
		audio[i+4] = 0xff
		offset = i + 5
	}
	duration, err := getWebMDuration(bytes.NewReader(audio))
	require.NoError(t, err)
	require.InDelta(t, 1.040, duration, 1e-8)
}

func TestWebMDurationScaleLacingAndPadding(t *testing.T) {
	audio := webMFixture(t, func(s *webm.Segment) {
		s.Info.TimecodeScale = 10_000_000
		s.Tracks.TrackEntry[0].CodecDelay = 6_500_000
		s.Cluster[0].SimpleBlock = nil
		s.Cluster[1].Timecode = 100
		s.Cluster[1].SimpleBlock = nil
		s.Cluster[1].BlockGroup = []webm.BlockGroup{{Block: ebml.Block{TrackNumber: 1, Data: [][]byte{{0xf8, 0xff, 0xfe}}}, BlockDuration: 2}}
	})
	duration, err := getWebMDuration(bytes.NewReader(audio))
	require.NoError(t, err)
	require.InDelta(t, 1.0135, duration, 1e-8)
}

func TestWebMDurationRejectsMalformedAndUnsupported(t *testing.T) {
	for _, mutate := range []func(*webm.Segment){
		func(s *webm.Segment) { s.Info.Duration = math.NaN() },
		func(s *webm.Segment) { s.Info.TimecodeScale = math.MaxUint64 },
		func(s *webm.Segment) { s.Tracks.TrackEntry[0].CodecID = "A_VORBIS" },
		func(s *webm.Segment) { s.Tracks.TrackEntry[0].TrackType = 1 },
		func(s *webm.Segment) { s.Tracks.TrackEntry = append(s.Tracks.TrackEntry, s.Tracks.TrackEntry[0]) },
		func(s *webm.Segment) { s.Cluster = nil },
		func(s *webm.Segment) { s.Cluster[1].SimpleBlock[0].TrackNumber = 2 },
		func(s *webm.Segment) { s.Cluster[1].Timecode = 0 },
		func(s *webm.Segment) { s.Cluster[1].SimpleBlock[0].Data = [][]byte{{0xfb, 0}} },
	} {
		_, err := getWebMDuration(bytes.NewReader(webMFixture(t, mutate)))
		require.Error(t, err)
	}
	audio := webMFixture(t, nil)
	_, duplicateErr := getWebMDuration(bytes.NewReader(append(append([]byte{}, audio...), audio...)))
	require.Error(t, duplicateErr)
	for _, end := range []int{0, 1, 4, len(audio) - 1, len(audio) - 5} {
		_, err := getWebMDuration(bytes.NewReader(audio[:end]))
		require.Error(t, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := getWebMDurationContext(ctx, bytes.NewReader(audio))
	require.ErrorIs(t, err, context.Canceled)
}

func TestOpusPacketTiming(t *testing.T) {
	for _, test := range []struct {
		packet  []byte
		seconds float64
	}{
		{[]byte{0x00}, .010}, {[]byte{0x18}, .060}, {[]byte{0x60}, .010},
		{[]byte{0x80}, .0025}, {[]byte{0xf8, 0xff, 0xfe}, .020},
		{[]byte{0xf9}, .040}, {[]byte{0xfb, 6}, .120},
	} {
		duration, err := opusPacketSeconds(test.packet)
		require.NoError(t, err)
		require.InDelta(t, test.seconds, duration, 1e-8)
	}
	for _, packet := range [][]byte{nil, {0xfb}, {0xfb, 0}, {0xfb, 7}, {0x83, 49}} {
		_, err := opusPacketSeconds(packet)
		require.Error(t, err)
	}
}
