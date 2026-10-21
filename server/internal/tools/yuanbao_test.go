package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aivory/server/internal/llm"
)

const yuanbaoFixture = `{"Response":{"Query":"腾讯云","Version":"standard","RequestId":"req-1","Pages":[
"{\"title\":\"First\",\"url\":\"https://source.test/one\",\"date\":\"2026-10-20 10:00:00\",\"passage\":\"Passage one\",\"content\":\"Content one\",\"pics\":[{\"caption\":\"pic\",\"origin_url\":\"https://images.test/one.jpg\"}]}",
"{\"title\":\"Second\",\"url\":\"https://source.test/two\",\"passage\":\"Passage two\"}",
"{\"title\":\"Duplicate\",\"url\":\"https://source.test/one\"}",
"not-json"
]}}`

// The expected signature was computed independently from the published
// TC3-HMAC-SHA256 algorithm, so a change to the canonical request breaks this
// test rather than silently shipping unsigned requests.
func TestYuanbaoSignsCloudAPIRequest(t *testing.T) {
	body := []byte(`{"Query":"腾讯云","Mode":1}`)
	req, err := http.NewRequest(http.MethodPost, yuanbaoEndpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", yuanbaoRequestContent)
	signYuanbao(req, body, "AKIDEXAMPLE", "SECRETKEYEXAMPLE", time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC))

	const want = "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-10-21/wsa/tc3_request, SignedHeaders=content-type;host, Signature=3de6c128ba373e17ae893ad19a7fbeb7e9d83afd96a6031f82280efa50aa2880"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("X-TC-Timestamp"); got != "1792569600" {
		t.Fatalf("X-TC-Timestamp = %q", got)
	}

	// The payload is part of the signature: tampering must change it.
	tampered := []byte(`{"Query":"腾讯云","Mode":2}`)
	other, _ := http.NewRequest(http.MethodPost, yuanbaoEndpoint, bytes.NewReader(tampered))
	other.Header.Set("Content-Type", yuanbaoRequestContent)
	signYuanbao(other, tampered, "AKIDEXAMPLE", "SECRETKEYEXAMPLE", time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC))
	if other.Header.Get("Authorization") == want {
		t.Fatal("signature did not cover the request body")
	}
}

func TestYuanbaoSearchParsesPagesAndSendsFilters(t *testing.T) {
	var received map[string]any
	var action, version, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		action, version, auth = r.Header.Get("X-TC-Action"), r.Header.Get("X-TC-Version"), r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(yuanbaoFixture))
	}))
	defer srv.Close()

	s := &yuanbaoSearcher{secretID: "id", secretKey: "key", endpoint: srv.URL}
	out, citations, err := s.SearchWithOptions(context.Background(), "腾讯云", 10, webSearchOptions{
		Mode:      intPtr(2),
		Industry:  "news",
		Freshness: "d7",
		Site:      "qq.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if action != yuanbaoAction || version != yuanbaoAPIVersion || !strings.HasPrefix(auth, "TC3-HMAC-SHA256 Credential=id/") {
		t.Fatalf("headers action=%q version=%q auth=%q", action, version, auth)
	}
	want := map[string]any{
		"Query": "腾讯云", "Mode": float64(2), "Industry": "news", "Freshness": "d7", "Site": "qq.com",
	}
	if len(received) != len(want) {
		t.Fatalf("request payload = %#v (Cnt must not be sent)", received)
	}
	for key, value := range want {
		if received[key] != value {
			t.Fatalf("payload[%s] = %#v, want %#v", key, received[key], value)
		}
	}
	// The malformed entry and the duplicate URL are dropped.
	if len(citations) != 2 || citations[0].URL != "https://source.test/one" || citations[1].URL != "https://source.test/two" {
		t.Fatalf("citations = %#v", citations)
	}
	if citations[0].Title != "First" || citations[0].Snippet != "Passage one" ||
		citations[0].ImageURL != "https://images.test/one.jpg" || citations[0].ThumbnailURL != "https://images.test/one.jpg" {
		t.Fatalf("first citation = %#v", citations[0])
	}
	if citations[1].ImageURL != "" || citations[1].Snippet != "Passage two" {
		t.Fatalf("second citation = %#v", citations[1])
	}
	if !strings.Contains(out, "Content one") || !strings.Contains(out, "(date: 2026-10-20 10:00:00)") {
		t.Fatalf("output lost body or date: %q", out)
	}
}

func TestYuanbaoMapsTimeRangeToFreshness(t *testing.T) {
	for _, test := range []struct{ name, timeRange, want string }{
		{"day", "day", "d1"},
		{"month", "month", "m1"},
		{"year", "year", "y1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var received map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&received)
				_, _ = w.Write([]byte(`{"Response":{"Pages":[]}}`))
			}))
			defer srv.Close()
			s := &yuanbaoSearcher{secretID: "id", secretKey: "key", endpoint: srv.URL}
			if _, _, err := s.SearchWithOptions(context.Background(), "q", 5, webSearchOptions{TimeRange: test.timeRange}); err != nil {
				t.Fatal(err)
			}
			if received["Freshness"] != test.want {
				t.Fatalf("Freshness = %#v, want %q", received["Freshness"], test.want)
			}
		})
	}
}

func TestYuanbaoEmptyPagesIsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"Response":{"Query":"q","Pages":[]}}`))
	}))
	defer srv.Close()
	s := &yuanbaoSearcher{secretID: "id", secretKey: "key", endpoint: srv.URL}
	out, citations, err := s.Search(context.Background(), "q", 5)
	if err != nil || len(citations) != 0 || !strings.Contains(out, "No web results found") {
		t.Fatalf("empty result = %q %+v %v", out, citations, err)
	}
}

func TestYuanbaoBusinessErrorIsActionable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"Response":{"Error":{"Code":"ResourceNotFound","Message":"service not opened"},"RequestId":"req-9"}}`))
	}))
	defer srv.Close()
	s := &yuanbaoSearcher{secretID: "id", secretKey: "key", endpoint: srv.URL}
	_, _, err := s.Search(context.Background(), "q", 5)
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := err.Error()
	for _, want := range []string{"not activated", "ResourceNotFound", "req-9"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q missing %q", msg, want)
		}
	}
}

func TestYuanbaoRejectsInvalidFiltersBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"Response":{"Pages":[]}}`))
	}))
	defer srv.Close()
	tool := &webSearchTool{searcher: &yuanbaoSearcher{secretID: "id", secretKey: "key", endpoint: srv.URL}}
	for _, input := range []string{
		`{"query":"x","mode":3}`,
		`{"query":"x","industry":"sports"}`,
		`{"query":"x","freshness":"d31"}`,
		`{"query":"x","freshness":"week"}`,
		`{"query":"x","freshness":"d1,m1"}`,
		`{"query":"x","site":"exclude:a.com|b.com|c.com|d.com|e.com|f.com"}`,
		`{"query":"x","site":"https://qq.com"}`,
	} {
		_, _, err := tool.Execute(context.Background(), []byte(input), nil)
		var userErr *llm.ToolUserError
		if !errors.As(err, &userErr) {
			t.Fatalf("%s: expected a repairable input error, got %v", input, err)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid inputs made %d requests", calls.Load())
	}
}

func TestYuanbaoRequiresBothCloudCredentials(t *testing.T) {
	if got := newSearcher("yuanbao", "", "", "", "", nil); got != nil {
		t.Fatalf("missing credentials built %#v", got)
	}
	if got := newSearcher("yuanbao", "", "", "id", "", nil); got != nil {
		t.Fatalf("missing SecretKey built %#v", got)
	}
	if _, ok := newSearcher("yuanbao", "", "", "id", "key", nil).(*yuanbaoSearcher); !ok {
		t.Fatal("valid credentials should build a yuanbaoSearcher")
	}
}

func TestYuanbaoCredentialsResolveFromFallbacks(t *testing.T) {
	s := newSettingsSearcher(nil, "yuanbao", "", "")
	if s.backend() != nil {
		t.Fatal("a provider without credentials must degrade to nil")
	}
	s.fallbackSecretID, s.fallbackSecretKey = "id", "key"
	if _, ok := s.backend().(*yuanbaoSearcher); !ok {
		t.Fatalf("credentials from the environment fallback were ignored: %T", s.backend())
	}
}

func intPtr(value int) *int { return &value }
