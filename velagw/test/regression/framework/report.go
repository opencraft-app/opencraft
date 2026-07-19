package framework

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
)

func (r Report) JSON(sanitizer *Sanitizer) ([]byte, error) {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return nil, err
	}
	return sanitizer.Bytes(raw), nil
}

type junitSuite struct {
	XMLName  xml.Name    `xml:"testsuite"`
	Name     string      `xml:"name,attr"`
	Tests    int         `xml:"tests,attr"`
	Failures int         `xml:"failures,attr"`
	Skipped  int         `xml:"skipped,attr"`
	Time     string      `xml:"time,attr"`
	Cases    []junitCase `xml:"testcase"`
}

type junitCase struct {
	Name    string        `xml:"name,attr"`
	Time    string        `xml:"time,attr"`
	Failure *junitFailure `xml:"failure,omitempty"`
	Skipped *junitSkipped `xml:"skipped,omitempty"`
}

type junitFailure struct {
	Message string `xml:"message,attr"`
}

type junitSkipped struct {
	Message string `xml:"message,attr,omitempty"`
}

func (r Report) JUnit(sanitizer *Sanitizer) ([]byte, error) {
	suite := junitSuite{Name: r.Scenario, Tests: len(r.Cases) + 1, Time: formatSeconds(r.FinishedAt.Sub(r.StartedAt))}
	for _, result := range r.Cases {
		item := junitCase{Name: result.ID, Time: formatSeconds(result.Duration)}
		switch result.Status {
		case CaseStatusFailed:
			suite.Failures++
			item.Failure = &junitFailure{Message: result.Error}
		case CaseStatusSkippedDependency:
			suite.Skipped++
			item.Skipped = &junitSkipped{Message: string(result.Status)}
		}
		suite.Cases = append(suite.Cases, item)
	}
	cleanup := junitCase{Name: "cleanup", Time: "0.000"}
	switch r.Cleanup.Status {
	case CleanupStatusFailed:
		suite.Failures++
		cleanup.Failure = &junitFailure{Message: cleanupError(r.Cleanup)}
	case CleanupStatusNotRun, "":
		suite.Skipped++
		cleanup.Skipped = &junitSkipped{Message: string(CleanupStatusNotRun)}
	}
	suite.Cases = append(suite.Cases, cleanup)
	raw, err := xml.MarshalIndent(suite, "", "  ")
	if err != nil {
		return nil, err
	}
	raw = append([]byte(xml.Header), raw...)
	return sanitizer.Bytes(raw), nil
}

func cleanupError(cleanup CleanupResult) string {
	for _, action := range cleanup.Actions {
		if action.Status == CleanupActionFailed && action.Error != "" {
			return action.Error
		}
	}
	return "cleanup failed"
}

func formatSeconds(duration interface{ Seconds() float64 }) string {
	return fmt.Sprintf("%.3f", duration.Seconds())
}
