package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"aivory/server/internal/llm"
)

func TestSearchProvidersDefaultToTenAndKeepCompleteResults(t *testing.T) {
	summary := strings.Repeat("完整摘要 ", 150) + "SUMMARY_END"
	article := "# Article\n\n" + strings.Repeat("正文内容 ", 250) + "BODY_END\n\nOriginal [1] marker."
	date := "2026-10-12"
	for _, provider := range []string{"serper", "brave", "tavily", "anysearch", "duckduckgo"} {
		t.Run(provider, func(t *testing.T) {
			previous := toolHTTPClient
			t.Cleanup(func() { toolHTTPClient = previous })
			var calls atomic.Int32
			toolHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls.Add(1)
				query := req.URL.Query().Get("q")
				var body map[string]any
				if req.Body != nil {
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if _, exists := body["queries"]; exists {
						t.Error("local batch parameter was sent upstream")
					}
					query, _ = body["query"].(string)
					if provider == "serper" {
						query, _ = body["q"].(string)
					}
				}
				var rows []map[string]any
				var html strings.Builder
				for i := 0; i < 10; i++ {
					link := fmt.Sprintf("https://source.test/%s/%d", query, i)
					if i == 0 {
						link = "https://source.test/shared"
					}
					row := map[string]any{"title": fmt.Sprintf("Result %d", i), "url": link}
					switch provider {
					case "serper":
						row["link"], row["snippet"], row["content"], row["date"] = link, summary, article, date
						row["thumbnailUrl"] = "https://images.test/thumb.jpg"
					case "brave":
						row["description"], row["content"], row["page_age"] = summary, article, date
						row["thumbnail"] = map[string]any{"src": "https://images.test/thumb.jpg"}
					case "tavily":
						row["content"], row["raw_content"], row["published_date"] = summary, article, date
					case "anysearch":
						row["snippet"], row["content"] = summary, article
					case "duckduckgo":
						fmt.Fprintf(&html, `<div class="result results_links"><a class="result__a" href="%s">Result %d</a><a class="result__snippet">%s</a></div>`, link, i, summary)
					}
					rows = append(rows, row)
				}
				var envelope any
				switch provider {
				case "serper":
					if body["num"] != float64(10) {
						t.Errorf("num=%v, want 10", body["num"])
					}
					envelope = map[string]any{"organic": rows}
				case "brave":
					if req.URL.Query().Get("count") != "10" {
						t.Errorf("count=%q, want 10", req.URL.Query().Get("count"))
					}
					envelope = map[string]any{"web": map[string]any{"results": rows}}
				case "tavily":
					if body["max_results"] != float64(10) || body["include_raw_content"] != "markdown" {
						t.Errorf("wrong Tavily count/body request: %v", body)
					}
					envelope = map[string]any{"results": rows}
				case "anysearch":
					if body["max_results"] != float64(10) || req.URL.String() != anySearchDefaultEndpoint {
						t.Errorf("wrong AnySearch request: %s, %v", req.URL, body)
					}
					envelope = map[string]any{"code": 0, "data": map[string]any{"results": rows}}
				}
				raw, err := json.Marshal(envelope)
				if err != nil {
					t.Error(err)
				}
				if provider == "duckduckgo" {
					raw = []byte(html.String())
				}
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw))), Request: req}, nil
			})}
			tool := &webSearchTool{searcher: newSettingsSearcher(nil, provider, "test-key", "https://search.test")}
			for _, input := range []string{`{"query":"alpha"}`, `{"queries":["alpha","beta"]}`} {
				before := calls.Load()
				out, citations, err := tool.Execute(t.Context(), []byte(input), nil)
				if err != nil {
					t.Fatal(err)
				}
				outputs := []string{out}
				wantCalls, wantCitations := int32(1), 10
				if strings.Contains(input, "queries") {
					wantCalls, wantCitations = 2, 19
					var batch webSearchBatchResult
					if err := json.Unmarshal([]byte(out), &batch); err != nil {
						t.Fatal(err)
					}
					if batch.Status != "complete" || len(batch.Items) != 2 || batch.Items[1].CitationIndexes[1] != 11 {
						t.Fatalf("wrong batch indexes: %+v", batch)
					}
					outputs = []string{batch.Items[0].Content, batch.Items[1].Content}
				}
				if calls.Load()-before != wantCalls || len(citations) != wantCitations {
					t.Fatalf("calls/results=%d/%d, want %d/%d", calls.Load()-before, len(citations), wantCalls, wantCitations)
				}
				for _, citation := range citations {
					if citation.Snippet != summary {
						t.Fatalf("summary was truncated: %q", citation.Snippet)
					}
				}
				for _, output := range outputs {
					if !strings.Contains(output, summary) || provider != "duckduckgo" && !strings.Contains(output, article) {
						t.Fatal("long summary or Markdown body was lost")
					}
					if provider != "anysearch" && provider != "duckduckgo" && !strings.Contains(output, "(date: "+date+")") {
						t.Fatal("publication date was lost")
					}
					if (provider == "serper" || provider == "brave") && !strings.Contains(output, "thumbnail_url: https://images.test/thumb.jpg") {
						t.Fatal("thumbnail metadata was lost")
					}
				}
			}
		})
	}
}

func TestSearchBodyKeepsFormattingWithoutDuplicatingFallbackExcerpt(t *testing.T) {
	body := "# Title\n\n" + strings.Repeat("正文 ", 150) + "\n\n- Item one\n- Item two"
	data := webSearchResults{items: []webSearchResultItem{{
		citation: llm.Citation{Title: "Article", URL: "https://source.test/body", Snippet: normalizeSnippet(body)},
		content:  body,
	}}}
	out, _ := data.output()
	if !strings.Contains(out, body) || strings.Count(out, "Item one") != 1 {
		t.Fatalf("body formatting lost or content duplicated: %s", out)
	}
}

func TestWebSearchBatchWithoutConfiguredBackendKeepsPlaceholder(t *testing.T) {
	tool := &webSearchTool{}
	out, citations, err := tool.Execute(context.Background(), []byte(`{"queries":["alpha","beta"]}`), nil)
	if err != nil || len(citations) != 1 || !strings.Contains(out, "Aivory local-only mode") {
		t.Fatalf("batch fallback failed: out=%q citations=%+v err=%v", out, citations, err)
	}
}

func TestSearxngKeepsLegacyDefaultAndAdministratorCount(t *testing.T) {
	previous := toolHTTPClient
	t.Cleanup(func() { toolHTTPClient = previous })
	toolHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, err := json.Marshal(searxngPage{Results: searchCountResults("existing", 0, 15, strings.Repeat("原摘要", 200))})
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body))), Request: req}, nil
	})}
	searcher := &searxngSearcher{baseURL: "https://existing-search.test"}
	tool := &webSearchTool{searcher: searcher}
	_, citations, err := tool.Execute(t.Context(), []byte(`{"query":"existing"}`), nil)
	if err != nil || len(citations) != 5 {
		t.Fatalf("legacy SearXNG default changed: count=%d err=%v", len(citations), err)
	}
	searcher.resultCount = 12
	_, citations, err = tool.Execute(t.Context(), []byte(`{"query":"existing","top_k":2}`), nil)
	if err != nil || len(citations) != 12 {
		t.Fatalf("administrator SearXNG count changed: count=%d err=%v", len(citations), err)
	}
}
