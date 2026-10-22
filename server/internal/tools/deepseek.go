package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"unicode/utf8"

	"aivory/server/internal/llm"
	"aivory/server/internal/tooldiagnostics"
)

const (
	deepSeekSearchEndpoint = "https://api.deepseek.com/v1/tools/search"
	deepSeekFetchEndpoint  = "https://api.deepseek.com/v1/tools/fetch"
	webProviderJSONLimit   = 4 << 20
)

type deepSeekSearcher struct{ apiKey string }

func (s *deepSeekSearcher) searchOptionsProperties() map[string]any {
	return map[string]any{
		"query":        map[string]any{"type": "string", "minLength": 1, "maxLength": 128, "description": "DeepSeek search query, at most 128 Unicode characters. Supports site:, -site:, exclusions, quoted phrases, lang:zh,en, after:YYYY-MM-DD and before:YYYY-MM-DD."},
		"queries":      map[string]any{"type": "array", "maxItems": 5, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 128}, "description": "Up to 5 independent DeepSeek queries sharing filters, each at most 128 Unicode characters. Use either query or queries."},
		"count":        map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "description": "DeepSeek results per query, default 10."},
		"ori_question": map[string]any{"type": "string", "minLength": 1, "maxLength": 128, "description": "Optional original user question, at most 128 Unicode characters, to clarify search intent."},
		"localization": map[string]any{"type": "string", "description": "Optional explicitly supplied IP address to prioritize local results. Omit unless localization is requested; never invent an address."},
		"need_content": map[string]any{"type": "boolean", "default": true, "description": "Return available page bodies along with summaries. Defaults to true in Aivory; use false when summaries suffice."},
	}
}

func (s *deepSeekSearcher) Search(ctx context.Context, query string, topK int) (string, []llm.Citation, error) {
	return s.SearchWithOptions(ctx, query, topK, webSearchOptions{})
}

func (s *deepSeekSearcher) SearchWithOptions(ctx context.Context, query string, topK int, options webSearchOptions) (string, []llm.Citation, error) {
	result, err := s.search(ctx, query, topK, options)
	text, citations := result.output()
	return text, citations, err
}

func (s *deepSeekSearcher) search(ctx context.Context, query string, topK int, options webSearchOptions) (webSearchResults, error) {
	query = strings.TrimSpace(query)
	if query == "" || utf8.RuneCountInString(query) > 128 {
		return webSearchResults{}, &llm.ToolUserError{Message: "DeepSeek query must contain 1–128 Unicode characters"}
	}
	if topK <= 0 {
		topK = defaultWebSearchResults
	}
	if options.Count != nil {
		topK = *options.Count
	}
	if topK < 1 || topK > 50 {
		return webSearchResults{}, &llm.ToolUserError{Message: "DeepSeek count must be between 1 and 50"}
	}
	question := strings.TrimSpace(options.OriginalQuestion)
	if options.OriginalQuestion != "" && (question == "" || utf8.RuneCountInString(question) > 128) {
		return webSearchResults{}, &llm.ToolUserError{Message: "ori_question must contain 1–128 Unicode characters"}
	}
	localization := strings.TrimSpace(options.Localization)
	if localization != "" && net.ParseIP(localization) == nil {
		return webSearchResults{}, &llm.ToolUserError{Message: "localization must be an IP address"}
	}
	needContent := options.NeedContent == nil || *options.NeedContent
	body, _ := json.Marshal(struct {
		Query            string `json:"query"`
		Count            int    `json:"count"`
		OriginalQuestion string `json:"ori_question,omitempty"`
		Localization     string `json:"localization,omitempty"`
		NeedContent      bool   `json:"need_content"`
	}{query, topK, question, localization, needContent})
	req, err := newWebProviderRequest(ctx, deepSeekSearchEndpoint, s.apiKey, body)
	if err != nil {
		return webSearchResults{}, err
	}
	raw, err := readWebProviderJSON(toolHTTPClient, req, "deepseek")
	if err != nil {
		return webSearchResults{}, err
	}
	var parsed struct {
		Results *[]struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Snippet string `json:"snippet"`
			Summary string `json:"summary"`
			Content string `json:"content"`
			Date    string `json:"date"`
		} `json:"results"`
	}
	if json.Unmarshal(raw, &parsed) != nil || parsed.Results == nil {
		return webSearchResults{}, fmt.Errorf("deepseek: invalid response: missing results array")
	}
	results := webSearchResults{}
	seen := map[string]bool{}
	for _, result := range *parsed.Results {
		link := searchImageURL(result.URL)
		if link == "" || seen[canonicalBatchURL(link)] {
			continue
		}
		seen[canonicalBatchURL(link)] = true
		title := strings.TrimSpace(result.Title)
		if title == "" {
			title = link
		}
		snippet := cleanSnippet(result.Snippet)
		if snippet == "" {
			snippet = cleanSnippet(result.Summary)
		}
		content := strings.TrimSpace(result.Content)
		if content == "" {
			content = strings.TrimSpace(result.Summary)
		}
		results.items = append(results.items, webSearchResultItem{
			citation: llm.Citation{Title: title, URL: link, Snippet: snippet, Source: "web"},
			content:  content, date: strings.TrimSpace(result.Date),
		})
		if len(results.items) == topK {
			break
		}
	}
	if len(results.items) == 0 {
		results.notice = "No web results found for this query."
	}
	return results, nil
}

func newWebProviderRequest(ctx context.Context, endpoint, apiKey string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(apiKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return req, nil
}

// Do not return upstream error bodies: quota responses can contain credentials.
// Diagnostics redact known secrets, and AnySearch's 402 body is omitted entirely.
func readWebProviderJSON(client *http.Client, req *http.Request, provider string) ([]byte, error) {
	resp, err := tooldiagnostics.Do(client, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if provider == "anysearch" && resp.StatusCode == http.StatusPaymentRequired {
		tooldiagnostics.OmitResponseBody(resp)
		return nil, fmt.Errorf("anysearch: HTTP 402: quota exhausted; configure an API key with available quota")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s: HTTP %d: %s", provider, resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webProviderJSONLimit+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > webProviderJSONLimit {
		return nil, fmt.Errorf("%s: response exceeds byte limit", provider)
	}
	return raw, nil
}
