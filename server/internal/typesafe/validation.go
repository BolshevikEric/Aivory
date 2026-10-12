package typesafe

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Validate the serialized request so structs, typed maps, raw JSON and slices
// all follow the same rules. The snapshot is reused for retries and response
// validation, so caller-owned maps cannot change the meaning between attempts.
func prepare(req Request) ([]byte, Request, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, Request{}, failure(ErrValidation, "request is not JSON serializable")
	}
	var snapshot Request
	if json.Unmarshal(body, &snapshot) != nil {
		return nil, Request{}, failure(ErrValidation, "invalid request JSON")
	}
	if !entry(snapshot.State, false) {
		return nil, Request{}, failure(ErrValidation, "state must be a string, object or array")
	}
	if len(snapshot.Questions) == 0 {
		return nil, Request{}, failure(ErrValidation, "at least one question is required")
	}
	for id, q := range snapshot.Questions {
		if strings.TrimSpace(id) == "" || !entry(q.Instructions, true) {
			return nil, Request{}, failure(ErrValidation, "invalid question id or instructions")
		}
		switch q.Type {
		case Choice:
			criteria, ok := q.Criteria.(map[string]any)
			if !ok || len(criteria) == 0 || len(criteria) > 255 {
				return nil, Request{}, failure(ErrValidation, "choice requires 1 to 255 options")
			}
			for _, v := range criteria {
				if !entry(v, true) {
					return nil, Request{}, failure(ErrValidation, "invalid choice description")
				}
			}
		case Score:
			levels, ok := q.Criteria.([]any)
			if !ok || len(levels) < 2 || len(levels) > 10 {
				return nil, Request{}, failure(ErrValidation, "score requires 2 to 10 ordered levels")
			}
			for _, v := range levels {
				if !entry(v, true) {
					return nil, Request{}, failure(ErrValidation, "invalid score description")
				}
			}
		case Noul:
			if q.Criteria == nil {
				continue
			}
			criteria, ok := q.Criteria.(map[string]any)
			if !ok {
				return nil, Request{}, failure(ErrValidation, "noul criteria must be an object")
			}
			for k, v := range criteria {
				if (k != "true" && k != "false") || !entry(v, true) {
					return nil, Request{}, failure(ErrValidation, "invalid noul criteria")
				}
			}
		default:
			return nil, Request{}, failure(ErrValidation, "unsupported question type")
		}
	}
	return body, snapshot, nil
}

func entry(v any, nullable bool) bool {
	switch v.(type) {
	case string, map[string]any, []any:
		return true
	case nil:
		return nullable
	default:
		return false
	}
}

func probability(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1
}

func validateResponse(req Request, result *Response, expected string) error {
	if expected != "" && result.Model != expected {
		return failure(ErrModelVersion, "served model does not match expected release")
	}
	for id, q := range req.Questions {
		a, ok := result.Answers[id]
		if a.Type == "" {
			a.Type = q.Type
		}
		if !ok || a.Type != q.Type {
			return failure(ErrResponse, "missing answer or mismatched answer type")
		}
		if q.Type == Noul {
			if a.Noul == nil || !probability(*a.Noul) {
				return failure(ErrResponse, "invalid noul answer")
			}
			a.Confidence = nil
			result.Answers[id] = a
			continue
		}
		if q.Type == Choice {
			options := q.Criteria.(map[string]any)
			if a.Choice == nil {
				return failure(ErrResponse, "invalid choice answer")
			}
			if _, ok := options[*a.Choice]; !ok {
				return failure(ErrResponse, "choice is not a requested option")
			}
		} else {
			levels := q.Criteria.([]any)
			if a.Score == nil || math.IsNaN(*a.Score) || math.IsInf(*a.Score, 0) || *a.Score < 0 || *a.Score > float64(len(levels)-1) {
				return failure(ErrResponse, "invalid score answer")
			}
			if a.Legend == nil {
				a.Legend = make(map[string]json.RawMessage, len(levels))
				for i, level := range levels {
					a.Legend[strconv.Itoa(i)], _ = json.Marshal(level)
				}
			}
		}
		if a.Confidence == nil || !probability(*a.Confidence) {
			confidence, ok := confidenceFromProbabilities(q, a)
			if !ok {
				return failure(ErrResponse, "missing confidence or probabilities")
			}
			a.Confidence = &confidence
		}
		result.Answers[id] = a
	}
	return nil
}

// Use the documented TypeSafe confidence formulas when only a distribution is returned.
func confidenceFromProbabilities(q Question, a Answer) (float64, bool) {
	keys := []string{}
	if q.Type == Choice {
		for key := range q.Criteria.(map[string]any) {
			keys = append(keys, key)
		}
	} else {
		for i := range q.Criteria.([]any) {
			keys = append(keys, strconv.Itoa(i))
		}
	}
	values := make([]float64, len(keys))
	total, peak := 0.0, 0
	for i, key := range keys {
		p, ok := a.Probabilities[key]
		if !ok || !probability(p) {
			return 0, false
		}
		values[i] = p
		total += p
		if p > values[peak] {
			peak = i
		}
	}
	if total <= 0 {
		return 0, false
	}
	if q.Type == Choice {
		if len(keys) == 1 {
			return 1, true
		}
		p := a.Probabilities[*a.Choice] / total
		return max(0, min(1, (float64(len(keys))*p-1)/float64(len(keys)-1))), true
	}
	spread, uniform := 0.0, 0.0
	for i, p := range values {
		spread += p / total * math.Abs(float64(i-peak))
		uniform += math.Abs(float64(i)-float64(len(keys)-1)/2) / float64(len(keys))
	}
	return max(0, min(1, 1-spread/uniform)), true
}
