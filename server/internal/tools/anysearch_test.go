package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
	"aivory/server/internal/tooldiagnostics"
)

const anySearchFixture = `{"code":0,"message":"success","request_id":"7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541","data":{"results":[{"title":"Go release notes","url":"https://go.dev/doc/go1.26","snippet":"Release summary","content":"# Go 1.26\n\nDetailed release notes."},{"title":"","url":"https://go.dev/doc/","content":"Documentation without a snippet."}],"metadata":{"total_results":2,"search_time_ms":312}}}`

func mockAnySearchHTTP(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	previous := toolHTTPClient
	toolHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != anySearchDefaultEndpoint {
			t.Errorf("request sent to an unofficial endpoint: %s", req.URL)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		resp := recorder.Result()
		resp.Request = req
		return resp, nil
	})}
	t.Cleanup(func() { toolHTTPClient = previous })
}

func TestAnySearchEndpointConfiguration(t *testing.T) {
	calls := 0
	mockAnySearchHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		fmt.Fprint(w, anySearchFixture)
	})
	for _, base := range []string{"", "https://api.anysearch.com", "https://search.example.test/mounted/v1/search", "file:///tmp/search"} {
		tool := &webSearchTool{searcher: newSettingsSearcher(nil, "anysearch", "", base)}
		if _, _, err := tool.Execute(t.Context(), []byte(`{"query":"test"}`), nil); err != nil {
			t.Fatalf("base=%q err=%v", base, err)
		}
	}
	if calls != 4 {
		t.Fatalf("search calls=%d, want 4", calls)
	}
}

func TestAnySearchAnonymousAndAuthenticatedRequests(t *testing.T) {
	for _, key := range []string{"", "test-api-key"} {
		t.Run(fmt.Sprintf("key=%t", key != ""), func(t *testing.T) {
			var received map[string]any
			mockAnySearchHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/search" || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("wrong request: %s %s %v", r.Method, r.URL, r.Header)
				}
				wantAuth := ""
				if key != "" {
					wantAuth = "Bearer " + key
				}
				if r.Header.Get("Authorization") != wantAuth {
					t.Error("wrong authorization header")
				}
				if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, anySearchFixture)
			})
			tool := &webSearchTool{searcher: newSettingsSearcher(nil, "anysearch", key, "")}
			out, citations, err := tool.Execute(t.Context(), []byte(`{"query":"Go 1.26 release notes"}`), nil)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(received, map[string]any{"query": "Go 1.26 release notes", "max_results": float64(10)}) {
				t.Fatalf("wrong default payload: %#v", received)
			}
			if len(citations) != 2 || citations[0].Snippet != "Release summary" || citations[1].Title != "https://go.dev/doc/" || citations[1].Snippet != "Documentation without a snippet." || !strings.Contains(out, "# Go 1.26\n\nDetailed release notes.") {
				t.Fatalf("lost result metadata/content: out=%q citations=%+v", out, citations)
			}
		})
	}
}

func TestAnySearchOptionalParametersAndResultLimit(t *testing.T) {
	var received map[string]any
	mockAnySearchHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, anySearchFixture)
	})
	tool := &webSearchTool{searcher: &anySearchSearcher{}}
	out, citations, err := tool.Execute(t.Context(), []byte(`{"query":"Go docs","max_results":1,"tag":"code.doc","zone":" INTL ","language":"ZH_cn","params":{"library":"golang","nested":{"version":"1.26"}},"format":"MARKDOWN"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"query": "Go docs", "max_results": float64(1), "tag": "code.doc", "zone": "intl", "language": "zh-CN", "params": map[string]any{"library": "golang", "nested": map[string]any{"version": "1.26"}}, "format": "markdown"}
	if !reflect.DeepEqual(received, want) || len(citations) != 1 || strings.Contains(out, "Documentation without") {
		t.Fatalf("parameters/limit lost: request=%#v out=%q citations=%+v", received, out, citations)
	}
	for _, input := range []string{`{"query":"x","max_results":0}`, `{"query":"x","max_results":11}`, `{"query":"x","max_results":1.5}`, `{"query":"x","tag":"code"}`, `{"query":"x","tag":"code.doc,finance.stock"}`, `{"query":"x","zone":"unknown"}`, `{"query":"x","format":"html"}`, `{"query":"x","params":"not an object"}`} {
		received = nil
		_, _, err := tool.Execute(t.Context(), []byte(input), nil)
		var userErr *llm.ToolUserError
		if !errors.As(err, &userErr) || received != nil {
			t.Fatalf("invalid input reached upstream: input=%s request=%v err=%v", input, received, err)
		}
	}
}

func TestAnySearchErrorsRetainStatusAndRequestIDWithoutCredentials(t *testing.T) {
	const requestID = "5a3f8c27-1e64-4b90-a752-6d9e2f41c083"
	for _, status := range []int{400, 401, 402, 403, 415, 429, 502} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			message := "Upstream request rejected."
			if status == 402 {
				message = "Your account and API key have been automatically generated.\nusername=generated-user\npassword=generated-password\napi_key=generated-api-key"
			}
			mockAnySearchHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				json.NewEncoder(w).Encode(map[string]any{"code": -1, "message": message, "request_id": requestID})
			})
			ctx, collector := tooldiagnostics.Start(t.Context(), true)
			searcher := &anySearchSearcher{}
			_, _, err := searcher.Search(ctx, "test query", 1)
			if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("HTTP %d", status)) || !strings.Contains(err.Error(), requestID) || calls != 1 {
				t.Fatalf("status/request ID lost or request retried: calls=%d err=%v", calls, err)
			}
			tooldiagnostics.Note(ctx, "search", err)
			requests, issues, hasErrors := collector.Snapshot()
			if !hasErrors || len(requests) != 1 || requests[0].StatusCode != status || !strings.Contains(requests[0].RequestBody, "test query") {
				t.Fatalf("missing tool diagnostics: requests=%+v issues=%+v", requests, issues)
			}
			if status == 402 {
				raw, _ := json.Marshal([]any{requests, issues, err.Error()})
				for _, secret := range []string{"generated-user", "generated-password", "generated-api-key"} {
					if strings.Contains(string(raw), secret) {
						t.Fatalf("credential-bearing quota response leaked into diagnostics")
					}
				}
				if requests[0].ResponseBody != "" {
					t.Fatal("402 response body was recorded")
				}
			} else if !strings.Contains(requests[0].ResponseBody, message) || !strings.Contains(err.Error(), message) {
				t.Fatalf("ordinary error detail lost: requests=%+v err=%v", requests, err)
			}
		})
	}
}

func TestAnySearchInvalidAndEmptyResults(t *testing.T) {
	for _, test := range []struct {
		body string
		fail bool
	}{
		{`{"code":0,"data":{"results":[]}}`, false},
		{`{"code":-1,"message":"Upstream unavailable","request_id":"test-id"}`, true},
		{`{"code":0}`, true},
		{`{"data":{"results":[]}}`, true},
		{`not JSON`, true},
		{`{"code":0,"data":{"results":[{"url":"javascript:alert(1)"},{"url":"https://user:password@source.test"}]}}`, false},
	} {
		t.Run(test.body, func(t *testing.T) {
			mockAnySearchHTTP(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, test.body) })
			out, citations, err := (&anySearchSearcher{}).Search(context.Background(), "x", 1)
			if (err != nil) != test.fail || len(citations) != 0 || (!test.fail && !strings.Contains(out, "No web results")) {
				t.Fatalf("unexpected empty/invalid result handling: out=%q citations=%+v err=%v", out, citations, err)
			}
		})
	}
}

func TestAnySearchSettingsAndSchemaChangeLive(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db, err := store.Open(filepath.Join(t.TempDir(), "anysearch-settings.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSetting(db, "search_provider", "anysearch"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSetting(db, "search_base_url", "https://legacy.example.test/v1/search"); err != nil {
		t.Fatal(err)
	}
	tool := &webSearchTool{searcher: newSettingsSearcher(db, "", "", "")}
	properties := searchSchemaProperties(t, tool)
	for _, name := range []string{"max_results", "tag", "zone", "language", "params", "format"} {
		if properties[name] == nil {
			t.Fatalf("AnySearch schema missing %s", name)
		}
	}
	if properties["top_k"] != nil || properties["categories"] != nil {
		t.Fatal("AnySearch advertises conflicting result counts or unsupported categories")
	}
	mockAnySearchHTTP(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, anySearchFixture) })
	if _, _, err := tool.Execute(t.Context(), []byte(`{"queries":["alpha","beta"]}`), nil); err != nil {
		t.Fatalf("stored base URL affected official search: %v", err)
	}
	if err := store.SetSetting(db, "search_provider", "brave"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSetting(db, "search_api_key", "test-key"); err != nil {
		t.Fatal(err)
	}
	properties = searchSchemaProperties(t, tool)
	if properties["tag"] != nil || properties["max_results"] != nil || properties["top_k"] == nil {
		t.Fatal("schema did not follow the live provider change")
	}
}

func TestAnySearchBatchPreservesContentAndCitations(t *testing.T) {
	mockAnySearchHTTP(t, func(w http.ResponseWriter, req *http.Request) {
		var input struct {
			Query string `json:"query"`
		}
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{"results": []map[string]any{
				{"url": "https://source.test/shared", "snippet": "Shared summary", "content": "# Shared " + input.Query},
				{"url": "https://source.test/" + input.Query, "snippet": "Summary " + input.Query, "content": "# Body " + input.Query + "\n\nOriginal [1] body marker."},
			}},
		})
	})
	tool := &webSearchTool{searcher: newSettingsSearcher(nil, "anysearch", "", "https://ignored.test")}
	out, citations, err := tool.Execute(t.Context(), []byte(`{"queries":["alpha","beta"]}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var batch webSearchBatchResult
	if err := json.Unmarshal([]byte(out), &batch); err != nil {
		t.Fatal(err)
	}
	if batch.Status != "complete" || len(batch.Items) != 2 || len(citations) != 3 {
		t.Fatalf("wrong batch results: batch=%+v citations=%+v", batch, citations)
	}
	for i, query := range []string{"alpha", "beta"} {
		item := batch.Items[i]
		if item.Query != query || !reflect.DeepEqual(item.CitationIndexes, []int{1, i + 2}) || !strings.Contains(item.Content, fmt.Sprintf("[%d] https://source.test/%s", i+2, query)) {
			t.Fatalf("wrong citation indexes: %+v", item)
		}
		for _, text := range []string{"Shared summary", "Summary " + query, "# Shared " + query, "# Body " + query, "Original [1] body marker."} {
			if !strings.Contains(item.Content, text) {
				t.Fatalf("batch lost or altered content %q: %+v", text, item)
			}
		}
	}
}

func TestAnySearchKeepsLongSummariesAndContent(t *testing.T) {
	summary := strings.Repeat("summary ", 80)
	content := "# Cleaned article\n\n" + strings.TrimSpace(strings.Repeat("full content ", 100))
	mockAnySearchHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{"results": []map[string]any{
				{"url": "https://source.test/both", "snippet": summary, "content": content},
				{"url": "https://source.test/summary", "snippet": summary},
				{"url": "https://source.test/body", "content": content},
			}},
		})
	})
	tool := &webSearchTool{searcher: &anySearchSearcher{}}
	for _, input := range []string{`{"query":"article"}`, `{"queries":["article","sources"]}`} {
		out, citations, err := tool.Execute(t.Context(), []byte(input), nil)
		if err != nil || len(citations) != 3 || citations[0].Snippet != strings.TrimSpace(summary) || citations[1].Snippet != strings.TrimSpace(summary) {
			t.Fatalf("summaries lost/truncated: citations=%+v err=%v", citations, err)
		}
		if strings.Contains(input, "queries") {
			var batch webSearchBatchResult
			if err := json.Unmarshal([]byte(out), &batch); err != nil {
				t.Fatal(err)
			}
			out = batch.Items[0].Content
		}
		if strings.Count(out, strings.TrimSpace(summary)) != 2 || strings.Count(out, content) != 2 {
			t.Fatalf("full summaries/content missing: %s", out)
		}
	}
}
