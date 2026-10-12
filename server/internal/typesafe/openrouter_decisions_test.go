package typesafe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const microsoftDecisionResponse = `{
  "answers": {
    "scope": {
      "choice": "search_only",
      "confidence": 0.9881778647009158,
      "probabilities": {
        "full_tools": 0.005911067649542063,
        "search_only": 0.9940889323504579
      },
      "type": "choice"
    }
  },
  "id": "gen-dec-1791698927-hanuwJ492oi497Gb8cwY",
  "model": "microsoft/microsoft-decision-1-20261009",
  "provider": "Azure",
  "usage": {"cost": 0.000008274, "input_tokens": 100, "output_tokens": 10}
}`

func openRouterScopeRequest(model string) Request {
	return Request{
		Model: model,
		State: "Summarize this message",
		Questions: map[string]Question{
			"scope": NewChoice("Choose the tool scope", map[string]any{
				"full_tools":  "Read pages and use tools",
				"search_only": "Use search summaries only",
			}),
		},
	}
}

func TestOpenRouterDecisionsResolvedModel(t *testing.T) {
	for _, tc := range []struct{ requestModel, servedModel string }{
		{"microsoft/decision-1", "microsoft/microsoft-decision-1-20261009"},
		{"microsoft/microsoft-decision-1", "microsoft/microsoft-decision-1-20261009"},
		{"typesafe/jev-1.13", "typesafe/jev-1.13-20260917"},
		{"vendor/decision-current", "vendor/decision-release-2"},
	} {
		t.Run(tc.requestModel, func(t *testing.T) {
			var record Record
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/alpha/decisions" {
					t.Errorf("request path=%s", r.URL.Path)
				}
				var sent Request
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil || sent.Model != tc.requestModel {
					t.Errorf("request model rewritten: model=%s err=%v", sent.Model, err)
				}
				fmt.Fprint(w, strings.Replace(microsoftDecisionResponse, "microsoft/microsoft-decision-1-20261009", tc.servedModel, 1))
			}, func(cfg *Config) {
				cfg.Protocol = OpenRouterDecisionsProtocol
				cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
			})
			result, err := c.Evaluate(t.Context(), openRouterScopeRequest(tc.requestModel), Options{})
			if err != nil {
				t.Fatalf("valid resolved Decision model rejected: %v", err)
			}
			if result.Model != tc.servedModel || result.RequestedModel != tc.requestModel || result.Provider != "Azure" || *result.Answers["scope"].Choice != "search_only" {
				t.Fatalf("response metadata/answer lost: %+v", result)
			}
			if record.RequestedModel != tc.requestModel || record.ServedModel != tc.servedModel || record.Attempts != 1 || record.StatusCode != http.StatusOK || !record.UsageKnown || record.Usage.InputTokens != 100 || record.ErrorKind != "" {
				t.Fatalf("incorrect recording: %+v", record)
			}
			if c.Stats().Failures != 0 || c.Stats().Attempts != 1 {
				t.Fatalf("resolved model causes retry or failure: %+v", c.Stats())
			}
		})
	}
}

func TestOpenRouterDecisionsExplicitExpectedModel(t *testing.T) {
	for _, expected := range []string{
		"microsoft/microsoft-decision-1-20261009",
		"microsoft/microsoft-decision-1-20261008",
		"microsoft/microsoft-decision-1",
	} {
		t.Run(expected, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, microsoftDecisionResponse)
			}, func(cfg *Config) { cfg.Protocol = OpenRouterDecisionsProtocol })
			result, err := c.Evaluate(t.Context(), openRouterScopeRequest("microsoft/decision-1"), Options{ExpectedModel: expected})
			if expected == "microsoft/microsoft-decision-1-20261009" {
				if err != nil || result == nil || len(result.Answers) != 1 {
					t.Fatalf("explicit resolved release rejected: result=%+v err=%v", result, err)
				}
				return
			}
			var apiErr *Error
			if !errors.As(err, &apiErr) || apiErr.Kind != ErrModelVersion || apiErr.StatusCode != http.StatusOK || apiErr.RequestID != "gen-dec-1791698927-hanuwJ492oi497Gb8cwY" {
				t.Fatalf("incorrect version error/context: %v", err)
			}
			if result == nil || len(result.Answers) != 0 || result.Usage.InputTokens != 100 || c.Stats().Attempts != 1 {
				t.Fatalf("invalid judgment exposed or accounting lost: %+v", result)
			}
		})
	}
}

func TestOpenRouterDecisionsInvalidResponseRetainsHTTPContext(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"unknown choice", `"choice": "search_only"`, `"choice": "unknown"`},
		{"wrong answer type", `"type": "choice"`, `"type": "noul"`},
		{"invalid usage", `"input_tokens": 100`, `"input_tokens": -1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, strings.Replace(microsoftDecisionResponse, tc.before, tc.after, 1))
			}, func(cfg *Config) { cfg.Protocol = OpenRouterDecisionsProtocol })
			result, err := c.Evaluate(t.Context(), openRouterScopeRequest("microsoft/decision-1"), Options{})
			var apiErr *Error
			if !errors.As(err, &apiErr) || apiErr.Kind != ErrResponse || apiErr.StatusCode != http.StatusOK || apiErr.RequestID != "gen-dec-1791698927-hanuwJ492oi497Gb8cwY" {
				t.Fatalf("invalid response accepted or HTTP context lost: %v", err)
			}
			if result != nil && len(result.Answers) != 0 {
				t.Fatal("invalid answers exposed")
			}
		})
	}
}
