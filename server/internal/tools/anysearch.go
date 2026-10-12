package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"aivory/server/internal/llm"
	"aivory/server/internal/tooldiagnostics"
)

const anySearchDefaultEndpoint = "https://api.anysearch.com/v1/search"
const anySearchResponseLimit = 4 << 20

var anySearchTagPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$`)
var anySearchRequestIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

type anySearchSearcher struct {
	apiKey string
}

type anySearchResponse struct {
	Code      *int   `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Data      *struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Snippet string `json:"snippet"`
			Content string `json:"content"`
		} `json:"results"`
	} `json:"data"`
}

func (s *anySearchSearcher) searchOptionsProperties() map[string]any {
	return map[string]any{
		"max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 10, "description": "AnySearch results per query, default 10."},
		"tag":         map[string]any{"type": "string", "maxLength": 128, "description": "Optional AnySearch capability tag in domain.sub_domain form. Use code.doc for code documentation; only use other tags when known. Omit for automatic intent routing."},
		"zone":        map[string]any{"type": "string", "enum": []string{"cn", "intl"}, "description": "Optional AnySearch source region: cn for China, intl for international sources. Select only when the user's task calls for a region."},
		"language":    map[string]any{"type": "string", "maxLength": 32, "description": "Preferred source language, e.g. zh-CN or en. Omit to let AnySearch choose."},
		"params":      map[string]any{"type": "object", "additionalProperties": true, "description": "Optional known AnySearch/AnyMix capability parameters, e.g. library: golang for code.doc or ticker: AAPL for a supported financial capability. Omit unknown parameters."},
		"format":      map[string]any{"type": "string", "enum": []string{"json", "markdown"}, "description": "Format of cleaned result content. Use markdown to preserve headings and structure; the response envelope always remains JSON."},
	}
}

func (s *anySearchSearcher) Search(ctx context.Context, query string, topK int) (string, []llm.Citation, error) {
	return s.SearchWithOptions(ctx, query, topK, webSearchOptions{})
}

func (s *anySearchSearcher) SearchWithOptions(ctx context.Context, query string, topK int, options webSearchOptions) (string, []llm.Citation, error) {
	result, err := s.search(ctx, query, topK, options)
	text, citations := result.output()
	return text, citations, err
}

func (s *anySearchSearcher) search(ctx context.Context, query string, topK int, options webSearchOptions) (webSearchResults, error) {
	options, err := normalizeWebSearchOptions(options)
	if err != nil {
		return webSearchResults{}, err
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return webSearchResults{}, &llm.ToolUserError{Message: "query is required"}
	}
	if topK <= 0 {
		topK = defaultWebSearchResults
	}
	if options.MaxResults != nil {
		topK = *options.MaxResults
	}
	if topK < 1 || topK > 10 {
		return webSearchResults{}, &llm.ToolUserError{Message: "AnySearch max_results must be between 1 and 10"}
	}
	options.Tag = strings.TrimSpace(options.Tag)
	options.Zone = strings.ToLower(strings.TrimSpace(options.Zone))
	options.Format = strings.ToLower(strings.TrimSpace(options.Format))
	if options.Tag != "" && (len(options.Tag) > 128 || !anySearchTagPattern.MatchString(options.Tag)) {
		return webSearchResults{}, &llm.ToolUserError{Message: "AnySearch tag must be a single domain.sub_domain value, e.g. code.doc"}
	}
	if options.Zone != "" && options.Zone != "cn" && options.Zone != "intl" {
		return webSearchResults{}, &llm.ToolUserError{Message: "AnySearch zone must be cn or intl"}
	}
	if options.Format != "" && options.Format != "json" && options.Format != "markdown" {
		return webSearchResults{}, &llm.ToolUserError{Message: "AnySearch format must be json or markdown"}
	}
	payload := struct {
		Query      string         `json:"query"`
		MaxResults int            `json:"max_results"`
		Tag        string         `json:"tag,omitempty"`
		Zone       string         `json:"zone,omitempty"`
		Language   string         `json:"language,omitempty"`
		Params     map[string]any `json:"params,omitempty"`
		Format     string         `json:"format,omitempty"`
	}{query, topK, options.Tag, options.Zone, options.Language, options.Params, options.Format}
	body, err := json.Marshal(payload)
	if err != nil {
		return webSearchResults{}, &llm.ToolUserError{Message: "invalid AnySearch parameters"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, anySearchDefaultEndpoint, bytes.NewReader(body))
	if err != nil {
		return webSearchResults{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if s.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+s.apiKey)
	}
	resp, err := tooldiagnostics.Do(toolHTTPClient, req)
	if err != nil {
		return webSearchResults{}, err
	}
	defer resp.Body.Close()
	// Anonymous quota errors can contain newly generated passwords and API keys.
	if resp.StatusCode == http.StatusPaymentRequired {
		tooldiagnostics.OmitResponseBody(resp)
	}
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, anySearchResponseLimit+1))
	var parsed anySearchResponse
	parseErr := json.Unmarshal(raw, &parsed)
	requestID := parsed.RequestID
	if !anySearchRequestIDPattern.MatchString(requestID) {
		requestID = resp.Header.Get("X-Request-ID")
		if !anySearchRequestIDPattern.MatchString(requestID) {
			requestID = ""
		}
	}
	fail := func(message string) (webSearchResults, error) {
		id := ""
		if requestID != "" {
			id = " (request_id=" + requestID + ")"
		}
		return webSearchResults{}, fmt.Errorf("anysearch: HTTP %d%s: %s", resp.StatusCode, id, message)
	}
	if resp.StatusCode == http.StatusPaymentRequired {
		return fail("quota exhausted; configure an API key with available quota. Response body omitted because it may contain generated credentials")
	}
	if readErr != nil {
		return webSearchResults{}, readErr
	}
	if len(raw) > anySearchResponseLimit {
		return fail("response exceeds byte limit")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(parsed.Message)
		if parseErr != nil || message == "" {
			message = http.StatusText(resp.StatusCode)
		}
		message, _ = tooldiagnostics.Limit(message, 4096)
		return fail(message)
	}
	if parseErr != nil || parsed.Code == nil {
		return fail("invalid response: expected a JSON result envelope")
	}
	if *parsed.Code != 0 {
		message, _ := tooldiagnostics.Limit(parsed.Message, 4096)
		return fail(fmt.Sprintf("business code %d: %s", *parsed.Code, message))
	}
	if parsed.Data == nil || parsed.Data.Results == nil {
		return fail("invalid response: missing data.results")
	}
	results := webSearchResults{items: make([]webSearchResultItem, 0, min(topK, len(parsed.Data.Results)))}
	seen := map[string]bool{}
	for _, result := range parsed.Data.Results {
		link := searchImageURL(result.URL)
		if link == "" || seen[canonicalBatchURL(link)] {
			continue
		}
		seen[canonicalBatchURL(link)] = true
		title := strings.TrimSpace(result.Title)
		if title == "" {
			title = link
		}
		snippet, content := normalizeSnippet(result.Snippet), strings.TrimSpace(result.Content)
		citationSnippet := snippet
		if citationSnippet == "" {
			citationSnippet = cleanSnippet(content)
		}
		results.items = append(results.items, webSearchResultItem{
			citation: llm.Citation{Title: title, URL: link, Snippet: citationSnippet, Source: "web"},
			content:  content,
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
