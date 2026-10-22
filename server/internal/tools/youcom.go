package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"aivory/server/internal/llm"
	"aivory/server/internal/tooldiagnostics"
)

// You.com search. With an API key (search_api_key, else YDC_API_KEY) it uses
// the keyed POST endpoint; without one it uses the keyless endpoint, which
// allows 100 searches a day counted per IP.
const (
	youComKeyedEndpoint   = "https://ydc-index.io/v1/search"
	youComKeylessEndpoint = "https://api.you.com/v1/agents/search"
	youComUserAgent       = "youdotcom-integration/hjxwz123-Aivory"
	youComResponseLimit   = 4 << 20
	youComMaxCount        = 100
)

// youComMaxRetryAfter caps how long one search waits out a 429. Longer waits
// fail fast with the advertised delay instead of blocking the tool call.
var youComMaxRetryAfter = 10 * time.Second

type youComSearcher struct{ apiKey string }

func newYouComSearcher(apiKey string) *youComSearcher {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("YDC_API_KEY"))
	}
	return &youComSearcher{apiKey: apiKey}
}

func (y *youComSearcher) Search(ctx context.Context, query string, topK int) (string, []llm.Citation, error) {
	results, err := y.search(ctx, query, topK, webSearchOptions{})
	text, citations := results.output()
	return text, citations, err
}

func (y *youComSearcher) newRequest(ctx context.Context, query string, count int) (*http.Request, error) {
	var req *http.Request
	var err error
	if y.apiKey != "" {
		body, _ := json.Marshal(map[string]any{"query": query, "count": count})
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, youComKeyedEndpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-API-Key", y.apiKey)
		req.Header.Set("Content-Type", "application/json")
	} else {
		params := url.Values{"query": {query}, "count": {strconv.Itoa(count)}}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, youComKeylessEndpoint+"?"+params.Encode(), nil)
		if err != nil {
			return nil, err
		}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", youComUserAgent)
	return req, nil
}

func (y *youComSearcher) do(ctx context.Context, query string, count int) (*http.Response, error) {
	req, err := y.newRequest(ctx, query, count)
	if err != nil {
		return nil, err
	}
	resp, err := tooldiagnostics.Do(toolHTTPClient, req)
	if err != nil || resp.StatusCode != http.StatusTooManyRequests {
		return resp, err
	}
	wait, ok := parseRetryAfter(resp.Header.Get("Retry-After"))
	if !ok || wait > youComMaxRetryAfter {
		return resp, nil
	}
	resp.Body.Close()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
	}
	req, err = y.newRequest(ctx, query, count)
	if err != nil {
		return nil, err
	}
	return tooldiagnostics.Do(toolHTTPClient, req)
}

func parseRetryAfter(value string) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second, true
	}
	if at, err := http.ParseTime(value); err == nil {
		d := time.Until(at)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

func (y *youComSearcher) search(ctx context.Context, query string, topK int, _ webSearchOptions) (webSearchResults, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return webSearchResults{}, &llm.ToolUserError{Message: "query is required"}
	}
	if topK <= 0 {
		topK = defaultWebSearchResults
	}
	if topK > youComMaxCount {
		topK = youComMaxCount
	}
	resp, err := y.do(ctx, query, topK)
	if err != nil {
		return webSearchResults{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return webSearchResults{}, fmt.Errorf("you.com: HTTP %d: the API key was rejected; check search_api_key or YDC_API_KEY", resp.StatusCode)
	case http.StatusPaymentRequired:
		return webSearchResults{}, fmt.Errorf("you.com: HTTP 402: search quota exhausted. The keyless tier allows 100 searches a day per IP; configure an API key for more")
	case http.StatusTooManyRequests:
		msg := "you.com: HTTP 429: rate limited"
		if wait, ok := parseRetryAfter(resp.Header.Get("Retry-After")); ok {
			msg += fmt.Sprintf("; retry after %s", wait.Round(time.Second))
		}
		return webSearchResults{}, fmt.Errorf("%s", msg)
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return webSearchResults{}, fmt.Errorf("you.com: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var parsed struct {
		Results struct {
			Web []struct {
				Title        string   `json:"title"`
				URL          string   `json:"url"`
				Description  string   `json:"description"`
				Snippets     []string `json:"snippets"`
				PageAge      string   `json:"page_age"`
				ThumbnailURL string   `json:"thumbnail_url"`
			} `json:"web"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, youComResponseLimit)).Decode(&parsed); err != nil {
		return webSearchResults{}, err
	}
	if len(parsed.Results.Web) == 0 {
		return webSearchResults{notice: "No web results found for this query."}, nil
	}
	results := webSearchResults{items: make([]webSearchResultItem, 0, len(parsed.Results.Web))}
	for _, r := range parsed.Results.Web {
		if len(results.items) >= topK {
			break
		}
		snippet := r.Description
		if snippet == "" && len(r.Snippets) > 0 {
			snippet = r.Snippets[0]
		}
		results.items = append(results.items, webSearchResultItem{
			citation: llm.Citation{Title: r.Title, URL: r.URL, Snippet: cleanSnippet(snippet), Source: "web", ThumbnailURL: searchImageURL(r.ThumbnailURL)},
			content:  strings.Join(r.Snippets, "\n\n"),
			date:     r.PageAge,
		})
	}
	return results, nil
}
