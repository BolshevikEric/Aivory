package tools

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"aivory/server/internal/llm"
)

func mockDeepSeekSearch(t *testing.T, handler func(*http.Request) *http.Response) {
	t.Helper()
	previous := toolHTTPClient
	t.Cleanup(func() { toolHTTPClient = previous })
	toolHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return handler(req), nil })}
}

func TestDeepSeekSearchFiltersBodiesAndSummaries(t *testing.T) {
	mockDeepSeekSearch(t, func(req *http.Request) *http.Response {
		if req.URL.String() != deepSeekSearchEndpoint || req.Method != http.MethodPost || req.Header.Get("Authorization") != "Bearer search-key" {
			t.Fatalf("unexpected request %s %s", req.Method, req.URL)
		}
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["count"] != float64(30) || body["need_content"] != true || body["ori_question"] != "用户问题" || body["localization"] != "1.1.1.1" {
			t.Fatalf("payload=%v", body)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"results":[{"title":"First","url":"https://example.test/one","snippet":"Short","summary":"Long summary","content":"Full body","date":"2026-10-22T00:00:00Z"},{"title":"Duplicate","url":"https://example.test/one"},{"title":"Second","url":"https://example.test/two","snippet":"","summary":"Summary when no body","content":"","date":null},{"url":"javascript:alert(1)"}]}`))}
	})
	tool := &webSearchTool{searcher: &deepSeekSearcher{apiKey: "search-key"}}
	schema := string(tool.InputSchema())
	if strings.Contains(schema, `"top_k"`) || !strings.Contains(schema, `"count"`) || !strings.Contains(schema, `"need_content"`) {
		t.Fatalf("schema=%s", schema)
	}
	out, cites, err := tool.Execute(context.Background(), []byte(`{"query":"文档 site:example.test","count":30,"ori_question":"用户问题","localization":"1.1.1.1"}`), nil)
	if err != nil || len(cites) != 2 || cites[0].Snippet != "Short" || cites[1].Snippet != "Summary when no body" {
		t.Fatalf("citations=%+v err=%v", cites, err)
	}
	for _, want := range []string{"Full body", "Summary when no body", "2026-10-22T00:00:00Z"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output lost %q: %s", want, out)
		}
	}
}

func TestDeepSeekSearchValidatesBeforeNetwork(t *testing.T) {
	mockDeepSeekSearch(t, func(req *http.Request) *http.Response {
		t.Fatalf("invalid input reached HTTP: %s", req.URL)
		return nil
	})
	tool := &webSearchTool{searcher: &deepSeekSearcher{apiKey: "key"}}
	for _, input := range []string{
		`{"query":"x","count":0}`, `{"query":"x","count":51}`, `{"query":"x","ori_question":"  "}`, `{"query":"x","localization":"somewhere"}`,
		`{"query":"` + strings.Repeat("界", 129) + `"}`,
	} {
		_, _, err := tool.Execute(context.Background(), []byte(input), nil)
		var userErr *llm.ToolUserError
		if !errors.As(err, &userErr) {
			t.Fatalf("input=%s error=%v", input, err)
		}
	}
}

func TestDeepSeekSearchEmptyMissingAndExplicitNoBody(t *testing.T) {
	for _, tc := range []struct {
		response  string
		wantError bool
	}{{`{"results":[]}`, false}, {`{}`, true}, {`{"results":null}`, true}, {`<html>bad</html>`, true}} {
		t.Run(tc.response, func(t *testing.T) {
			mockDeepSeekSearch(t, func(req *http.Request) *http.Response {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				if body["need_content"] != false {
					t.Fatalf("need_content=%v", body)
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(tc.response))}
			})
			noBody := false
			out, cites, err := (&deepSeekSearcher{apiKey: "key"}).SearchWithOptions(context.Background(), strings.Repeat("界", 128), 5, webSearchOptions{NeedContent: &noBody})
			if (err != nil) != tc.wantError || len(cites) != 0 {
				t.Fatalf("out=%q cites=%v err=%v", out, cites, err)
			}
		})
	}
	if newSearcher("deepseek", "", "", "", "") != nil {
		t.Fatal("missing key built a searcher")
	}
}
