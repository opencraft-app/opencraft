package common

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"
)

// Audio-only WebM/Opus duration, computed from blocks rather than untrusted
// Info.Duration. MediaRecorder commonly omits Duration and streams unknown-size
// Segment/Cluster elements. No files, ffprobe, goroutines or PCM decode are used.
// References: Matroska codec mapping A_OPUS; RFC 6716 sections 3.1/3.2.
func getWebMDurationContext(ctx context.Context, r io.ReadSeeker) (float64, error) {
	size, err := r.Seek(0, io.SeekEnd)
	if err != nil || size <= 0 || size > 128<<20 {
		return 0, errors.New("invalid or oversized WebM")
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	if err := validateWebMStructure(ctx, r, size); err != nil {
		return 0, err
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	var document struct {
		EBML    webm.EBMLHeader
		Segment struct {
			Info    webm.Info
			Tracks  webm.Tracks
			Cluster struct {
				Timecode    uint64
				SimpleBlock ebml.Block
				BlockGroup  struct {
					Block          ebml.Block
					BlockDuration  uint64
					DiscardPadding int64
				}
			}
		}
	}
	var parseErr error
	var track webm.TrackEntry
	var tracksSeen, clockSeen bool
	var clock uint64
	scale := uint64(1_000_000)
	var end, groupEnd float64
	var groupSeconds float64
	var previousEnd float64
	var previousBlock bool
	var blockCount, infoCount, trackCount int
	blockEnd := func(block ebml.Block) float64 {
		if !tracksSeen || !clockSeen || block.TrackNumber != track.TrackNumber || len(block.Data) == 0 {
			parseErr = errors.New("invalid WebM audio block or track")
			return 0
		}
		seconds := 0.0
		for _, packet := range block.Data {
			d, err := opusPacketSeconds(packet)
			if err != nil {
				parseErr = err
				return 0
			}
			seconds += d
		}
		start := (float64(clock)+float64(block.Timecode))*float64(scale)/1e9 - float64(track.CodecDelay)/1e9
		// Permit timestamp quantization by one tick, but reject duplicate or
		// overlapping audio timelines which could understate billed duration.
		if previousBlock && start < previousEnd-float64(scale)/1e9-1e-9 {
			parseErr = errors.New("overlapping or nonmonotonic WebM audio timestamps")
			return 0
		}
		previousEnd = start + seconds
		previousBlock = true
		blockCount++
		groupSeconds = seconds
		// Signed relative timecodes may be negative for codec preroll.
		return previousEnd
	}
	hook := func(element *ebml.Element) {
		if parseErr != nil {
			return
		}
		switch element.Name {
		case "EBML":
			if document.EBML.DocType != "webm" {
				parseErr = errors.New("not a WebM document")
			}
		case "Info":
			infoCount++
			if infoCount != 1 || blockCount != 0 {
				parseErr = errors.New("duplicate or late WebM Info")
				return
			}
			if document.Segment.Info.TimecodeScale != 0 {
				scale = document.Segment.Info.TimecodeScale
			}
			if scale == 0 || scale > 1e9 || math.IsNaN(document.Segment.Info.Duration) || math.IsInf(document.Segment.Info.Duration, 0) || document.Segment.Info.Duration < 0 {
				parseErr = errors.New("invalid WebM timing metadata")
			}
		case "Tracks":
			trackCount++
			entries := document.Segment.Tracks.TrackEntry
			if trackCount != 1 || blockCount != 0 || len(entries) != 1 {
				parseErr = errors.New("WebM requires one audio track")
				return
			}
			track = entries[0]
			if track.TrackType != 2 || track.TrackNumber == 0 || track.CodecID != "A_OPUS" || track.CodecDelay > 120_000_000 ||
				len(track.CodecPrivate) < 19 || string(track.CodecPrivate[:8]) != "OpusHead" || track.CodecPrivate[8] > 15 ||
				track.CodecPrivate[9] == 0 || track.CodecPrivate[9] > 2 || track.CodecPrivate[18] != 0 {
				parseErr = errors.New("unsupported WebM track: requires mono/stereo Opus")
				return
			}
			tracksSeen = true
		case "Timestamp", "Timecode":
			clock = element.Value.(uint64)
			clockSeen = true
		case "SimpleBlock":
			end = math.Max(end, blockEnd(element.Value.(ebml.Block)))
		case "Block":
			groupEnd = blockEnd(element.Value.(ebml.Block))
		case "BlockGroup":
			padding := document.Segment.Cluster.BlockGroup.DiscardPadding
			if padding < 0 || float64(padding)/1e9 > groupSeconds {
				parseErr = errors.New("unsupported WebM discard padding")
				return
			}
			end = math.Max(end, groupEnd-float64(padding)/1e9)
			previousEnd = groupEnd - float64(padding)/1e9
			document.Segment.Cluster.BlockGroup = struct {
				Block          ebml.Block
				BlockDuration  uint64
				DiscardPadding int64
			}{}
			groupEnd = 0
			groupSeconds = 0
		case "Cluster":
			clockSeen = false
		}
	}
	err = ebml.Unmarshal(&webMContextReader{ctx: ctx, r: r, failed: &parseErr}, &document,
		ebml.WithMaxLeafElementSize(1<<20), ebml.WithElementReadHooks(hook))
	if parseErr != nil {
		return 0, parseErr
	}
	if err != nil {
		return 0, errors.New("invalid WebM structure or truncated audio")
	}
	if infoCount != 1 || !tracksSeen || blockCount == 0 || !isFinitePositiveWebM(end) || end > 86400 {
		return 0, errors.New("WebM contains no usable Opus audio")
	}
	return end, nil
}

func isFinitePositiveWebM(v float64) bool { return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }

type webMContextReader struct {
	ctx    context.Context
	r      io.Reader
	failed *error
}

func (r *webMContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if *r.failed != nil {
		return 0, *r.failed
	}
	return r.r.Read(p)
}

// Opus TOC signals frame duration and packet frame count, including 2.5ms
// CELT and 60ms SILK frames. No packet can contain more than 120ms of audio.
func opusPacketSeconds(packet []byte) (float64, error) {
	bad := errors.New("invalid Opus packet timing")
	if len(packet) == 0 {
		return 0, bad
	}
	config := packet[0] >> 3
	var frame float64
	switch {
	case config < 12:
		frame = []float64{.010, .020, .040, .060}[config&3]
	case config < 16:
		frame = []float64{.010, .020}[config&1]
	default:
		frame = []float64{.0025, .005, .010, .020}[config&3]
	}
	count := 1
	switch packet[0] & 3 {
	case 1, 2:
		count = 2
	case 3:
		if len(packet) < 2 {
			return 0, bad
		}
		count = int(packet[1] & 63)
	}
	seconds := frame * float64(count)
	if count == 0 || count > 48 || seconds > .12000001 {
		return 0, bad
	}
	return seconds, nil
}

// The EBML library validates scalar sizes. This framing pass additionally
// rejects truncated finite master elements, which otherwise look like normal
// EOF, without allocating buffers sized by attacker-controlled declarations.
func validateWebMStructure(ctx context.Context, r io.ReadSeeker, size int64) error {
	bad := errors.New("invalid or truncated WebM element")
	elements := 0
	rootHeader, rootSegment := false, false
	var walk func(int64, uint64, bool, int) error
	walk = func(limit int64, parent uint64, unknown bool, depth int) error {
		if depth > 8 {
			return bad
		}
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			start, err := r.Seek(0, io.SeekCurrent)
			if err != nil {
				return err
			}
			if start == limit {
				return nil
			}
			if start > limit {
				return bad
			}
			id, _, err := readWebMVint(r, true)
			if err != nil {
				return bad
			}
			if unknown && parent == 0x1f43b675 && webMSegmentChild(id) {
				_, err = r.Seek(start, io.SeekStart)
				return err
			}
			if parent == 0 {
				switch id {
				case 0x1a45dfa3:
					if rootHeader || rootSegment {
						return bad
					}
					rootHeader = true
				case 0x18538067:
					if !rootHeader || rootSegment {
						return bad
					}
					rootSegment = true
				default:
					return bad
				}
			}
			length, indefinite, err := readWebMVint(r, false)
			if err != nil {
				return bad
			}
			position, err := r.Seek(0, io.SeekCurrent)
			if err != nil || position > limit || (!indefinite && length > uint64(limit-position)) {
				return bad
			}
			elements++
			if elements > 1_000_000 {
				return bad
			}
			master := false
			switch id {
			case 0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0:
				master = true
			}
			if master {
				validParent := false
				switch id {
				case 0x1a45dfa3, 0x18538067:
					validParent = parent == 0
				case 0x1549a966, 0x1654ae6b, 0x1f43b675:
					validParent = parent == 0x18538067
				case 0xae:
					validParent = parent == 0x1654ae6b
				case 0xe1:
					validParent = parent == 0xae
				case 0xa0:
					validParent = parent == 0x1f43b675
				}
				if !validParent {
					return bad
				}
			}
			if indefinite && id != 0x18538067 && id != 0x1f43b675 {
				return bad
			}
			end := limit
			if !indefinite {
				end = position + int64(length)
			}
			if master {
				if err := walk(end, id, indefinite, depth+1); err != nil {
					return err
				}
			} else if _, err := r.Seek(end, io.SeekStart); err != nil {
				return err
			}
		}
	}
	// Only a single EBML document and Segment are admitted.
	id, _, err := readWebMVint(r, true)
	if err != nil || id != 0x1a45dfa3 {
		return bad
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := walk(size, 0, false, 0); err != nil {
		return err
	}
	if !rootHeader || !rootSegment {
		return bad
	}
	return nil
}

func webMSegmentChild(id uint64) bool {
	switch id {
	case 0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770:
		return true
	}
	return false
}

func readWebMVint(r io.Reader, id bool) (uint64, bool, error) {
	var b [8]byte
	if _, err := io.ReadFull(r, b[:1]); err != nil {
		return 0, false, err
	}
	width, mask := 1, byte(0x80)
	for width <= 8 && b[0]&mask == 0 {
		width++
		mask >>= 1
	}
	if width > 8 || (id && width > 4) {
		return 0, false, errors.New("invalid EBML vint")
	}
	if _, err := io.ReadFull(r, b[1:width]); err != nil {
		return 0, false, err
	}
	if !id {
		b[0] &= mask - 1
	}
	var padded [8]byte
	copy(padded[8-width:], b[:width])
	value := binary.BigEndian.Uint64(padded[:])
	unknown := !id && value == (uint64(1)<<uint(width*7))-1
	return value, unknown, nil
}
