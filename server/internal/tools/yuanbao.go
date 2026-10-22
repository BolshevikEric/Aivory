package tools

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"aivory/server/internal/llm"
	"aivory/server/internal/tooldiagnostics"
)

// Tencent Cloud Yuanbao Search (元宝搜索, product wsa). This is a Cloud API 3.0
// service: requests are signed with TC3-HMAC-SHA256 using the account's
// SecretId/SecretKey, not with a single bearer token. The Response.Pages field
// is an array of JSON strings, so every entry is decoded a second time.
const (
	yuanbaoEndpoint       = "https://wsa.tencentcloudapi.com"
	yuanbaoAction         = "SearchPro"
	yuanbaoAPIVersion     = "2025-05-08"
	yuanbaoService        = "wsa"
	yuanbaoResponseLimit  = 4 << 20
	yuanbaoRequestContent = "application/json; charset=utf-8"
)

var (
	// d[N] / m[N] / y[N] / yyyy-mm-dd / yyyy-mm-dd,yyyy-mm-dd — the five shapes
	// documented for Freshness; mixing them is rejected by the upstream API.
	yuanbaoFreshnessPattern = regexp.MustCompile(`^(d([1-9]|[12][0-9]|30)|m([1-9]|1[0-2])|y[1-5]|[0-9]{4}-[0-9]{2}-[0-9]{2}(,[0-9]{4}-[0-9]{2}-[0-9]{2})?)$`)
	// A single domain, or "exclude:a.com|b.com" with at most five domains.
	yuanbaoSitePattern = regexp.MustCompile(`^(exclude:)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\|[a-z0-9]([a-z0-9.-]*[a-z0-9])?){0,4}$`)
)

type yuanbaoSearcher struct {
	secretID  string
	secretKey string
	// endpoint / now are overridable in tests; empty and nil use the official
	// endpoint and the wall clock.
	endpoint string
	now      func() time.Time
}

type yuanbaoResponse struct {
	Response struct {
		Query     string   `json:"Query"`
		Pages     []string `json:"Pages"`
		Version   string   `json:"Version"`
		Msg       string   `json:"Msg"`
		RequestID string   `json:"RequestId"`
		Error     *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
	} `json:"Response"`
}

type yuanbaoPage struct {
	Title     string  `json:"title"`
	URL       string  `json:"url"`
	Date      string  `json:"date"`
	Passage   string  `json:"passage"`
	Content   string  `json:"content"`
	Site      string  `json:"site"`
	Score     float64 `json:"score"`
	Authority float64 `json:"authority_level"`
	Favicon   string  `json:"favicon"`
	Deeplinks []struct {
		Title string `json:"title"`
		URL   string `json:"url"`
	} `json:"deeplinks"`
	Pics []struct {
		Caption   string `json:"caption"`
		OriginURL string `json:"origin_url"`
	} `json:"pics"`
}

func (s *yuanbaoSearcher) searchOptionsProperties() map[string]any {
	return map[string]any{
		"mode": map[string]any{
			"type": "integer", "enum": []int{0, 1, 2},
			"description": "Yuanbao result type: 0 public web sources, 1 authoritative vertical sources (government/news/academic/finance cards), 2 mixed. Omit for the backend default. The lite plan rejects this parameter.",
		},
		"industry": map[string]any{
			"type": "string", "enum": []string{"gov", "news", "acad", "finance"},
			"description": "Yuanbao vertical domain: gov for government, news for journalism, acad for academic papers, finance for markets. Omit unless the request targets one of these domains; the lite plan rejects this parameter.",
		},
		"freshness": map[string]any{
			"type": "string", "maxLength": 64,
			"description": "Exact publication window: d7 (last 7 days), m3 (last 3 months), y2 (last 2 years), 2026-08-20 (one day), or 2026-08-20,2026-08-30 (inclusive range). Prefer this over time_range for an exact window; the five shapes cannot be mixed.",
		},
		"site": map[string]any{
			"type": "string", "maxLength": 512,
			"description": "Restrict or exclude sources by domain. Use qq.com to search only that domain, or exclude:qq.com|sohu.com to drop up to five domains. Applies to public web results only, not to authoritative vertical cards.",
		},
	}
}

func (s *yuanbaoSearcher) Search(ctx context.Context, query string, topK int) (string, []llm.Citation, error) {
	return s.SearchWithOptions(ctx, query, topK, webSearchOptions{})
}

func (s *yuanbaoSearcher) SearchWithOptions(ctx context.Context, query string, topK int, options webSearchOptions) (string, []llm.Citation, error) {
	result, err := s.search(ctx, query, topK, options)
	text, citations := result.output()
	return text, citations, err
}

func (s *yuanbaoSearcher) search(ctx context.Context, query string, topK int, options webSearchOptions) (webSearchResults, error) {
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
	if topK < 1 || topK > 10 {
		return webSearchResults{}, &llm.ToolUserError{Message: "top_k must be between 1 and 10"}
	}

	payload := struct {
		Query     string `json:"Query"`
		Mode      *int   `json:"Mode,omitempty"`
		Site      string `json:"Site,omitempty"`
		Industry  string `json:"Industry,omitempty"`
		Freshness string `json:"Freshness,omitempty"`
	}{
		Query:     query,
		Mode:      options.Mode,
		Site:      options.Site,
		Industry:  options.Industry,
		Freshness: yuanbaoFreshness(options),
	}
	// Cnt is deliberately never sent: the lite plan rejects it, its default (10)
	// matches top_k's ceiling, and the caller truncates locally anyway.
	body, err := json.Marshal(payload)
	if err != nil {
		return webSearchResults{}, &llm.ToolUserError{Message: "invalid search parameters"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url(), bytes.NewReader(body))
	if err != nil {
		return webSearchResults{}, err
	}
	req.Header.Set("Content-Type", yuanbaoRequestContent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-TC-Action", yuanbaoAction)
	req.Header.Set("X-TC-Version", yuanbaoAPIVersion)
	now := time.Now().UTC()
	if s.now != nil {
		now = s.now().UTC()
	}
	signYuanbao(req, body, s.secretID, s.secretKey, now)

	resp, err := tooldiagnostics.Do(toolHTTPClient, req)
	if err != nil {
		return webSearchResults{}, err
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, yuanbaoResponseLimit+1))
	var parsed yuanbaoResponse
	parseErr := json.Unmarshal(raw, &parsed)
	fail := func(message string) (webSearchResults, error) {
		id := ""
		if parsed.Response.RequestID != "" {
			id = " (request_id=" + parsed.Response.RequestID + ")"
		}
		return webSearchResults{}, fmt.Errorf("yuanbao: %s%s", message, id)
	}
	if readErr != nil {
		return webSearchResults{}, readErr
	}
	if len(raw) > yuanbaoResponseLimit {
		return fail("response exceeds byte limit")
	}
	if parseErr != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fail(fmt.Sprintf("HTTP %d: %s", resp.StatusCode, http.StatusText(resp.StatusCode)))
		}
		return fail("invalid response: expected a JSON result envelope")
	}
	// Cloud API 3.0 reports business failures inside Response.Error, usually
	// with HTTP 200.
	if apiErr := parsed.Response.Error; apiErr != nil {
		return fail(yuanbaoErrorMessage(apiErr.Code, apiErr.Message))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(parsed.Response.Msg)
		if message == "" {
			message = http.StatusText(resp.StatusCode)
		}
		return fail(fmt.Sprintf("HTTP %d: %s", resp.StatusCode, message))
	}

	results := webSearchResults{items: make([]webSearchResultItem, 0, min(topK, len(parsed.Response.Pages)))}
	seen := make(map[string]bool, len(parsed.Response.Pages))
	for _, encoded := range parsed.Response.Pages {
		var page yuanbaoPage
		if json.Unmarshal([]byte(encoded), &page) != nil {
			// One malformed entry must not discard the rest of the response.
			continue
		}
		link := searchImageURL(page.URL)
		if link == "" || seen[canonicalBatchURL(link)] {
			continue
		}
		seen[canonicalBatchURL(link)] = true
		title := strings.TrimSpace(page.Title)
		if title == "" {
			title = link
		}
		content := strings.TrimSpace(page.Content)
		snippet := cleanSnippet(page.Passage)
		if snippet == "" {
			snippet = cleanSnippet(content)
		}
		imageURL := ""
		for _, pic := range page.Pics {
			if candidate := searchImageURL(pic.OriginURL); candidate != "" {
				imageURL = candidate
				break
			}
		}
		results.items = append(results.items, webSearchResultItem{
			citation: llm.Citation{
				Title: title, URL: link, Snippet: snippet, Source: "web",
				ImageURL: imageURL, ThumbnailURL: imageURL,
			},
			content: content,
			date:    strings.TrimSpace(page.Date),
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

func (s *yuanbaoSearcher) url() string {
	if s.endpoint != "" {
		return s.endpoint
	}
	return yuanbaoEndpoint
}

// yuanbaoFreshness prefers the precise Freshness parameter and falls back to
// mapping the shared time_range filter onto its documented shapes.
func yuanbaoFreshness(options webSearchOptions) string {
	if options.Freshness != "" {
		return options.Freshness
	}
	switch options.TimeRange {
	case "day":
		return "d1"
	case "month":
		return "m1"
	case "year":
		return "y1"
	}
	return ""
}

// yuanbaoErrorMessage turns Cloud API error codes into actionable messages.
func yuanbaoErrorMessage(code, message string) string {
	message = strings.TrimSpace(message)
	switch code {
	case "ResourceNotFound", "ResourceUnavailable":
		return fmt.Sprintf("the Yuanbao search product is not activated or unavailable (%s): %s; enable it in the Tencent Cloud console", code, message)
	case "UnauthorizedOperation", "AuthFailure":
		return fmt.Sprintf("the configured credentials cannot call Yuanbao search (%s): %s; check SecretId/SecretKey permissions", code, message)
	case "RequestLimitExceeded":
		return fmt.Sprintf("rate limited by Yuanbao search (%s): %s; retry later", code, message)
	}
	return fmt.Sprintf("%s: %s", code, message)
}

// signYuanbao applies Cloud API 3.0 TC3-HMAC-SHA256 signing to req. The signed
// headers are content-type and host, matching the POST-JSON example in the
// official documentation.
func signYuanbao(req *http.Request, body []byte, secretID, secretKey string, now time.Time) {
	timestamp := strconv.FormatInt(now.Unix(), 10)
	date := now.Format("2006-01-02")
	host := req.URL.Host
	payloadHash := sha256.Sum256(body)
	canonicalHeaders := "content-type:" + yuanbaoRequestContent + "\nhost:" + host + "\n"
	signedHeaders := "content-type;host"
	canonicalRequest := "POST\n/\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + hex.EncodeToString(payloadHash[:])

	canonicalHash := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + yuanbaoService + "/tc3_request"
	stringToSign := "TC3-HMAC-SHA256\n" + timestamp + "\n" + scope + "\n" + hex.EncodeToString(canonicalHash[:])

	mac := func(key []byte, message string) []byte {
		h := hmac.New(sha256.New, key)
		h.Write([]byte(message))
		return h.Sum(nil)
	}
	secretDate := mac([]byte("TC3"+secretKey), date)
	secretService := mac(secretDate, yuanbaoService)
	secretSigning := mac(secretService, "tc3_request")
	signature := hex.EncodeToString(mac(secretSigning, stringToSign))

	req.Header.Set("X-TC-Timestamp", timestamp)
	req.Header.Set("Authorization", "TC3-HMAC-SHA256 Credential="+secretID+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}
