package tools

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const youComFixture = `{"results":{"web":[{"title":"Go release notes","url":"https://go.dev/doc/go1.26","description":"Release   summary","snippets":["First excerpt.","Second excerpt."],"page_age":"2026-02-10T00:00:00","thumbnail_url":"https://go.dev/thumb.png"},{"title":"Docs","url":"https://go.dev/doc/","snippets":["Only a snippet."]}]},"metadata":{"query":"go"}}`

func mockYouComHTTP(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	previous := toolHTTPClient
	toolHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		resp := recorder.Result()
		resp.Request = req
		return resp, nil
	})}
	t.Cleanup(func() { toolHTTPClient = previous })
}

func TestYouComKeylessRequest(t *testing.T) {
	t.Setenv("YDC_API_KEY", "")
	mockYouComHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || "https://"+r.Host+r.URL.Path != youComKeylessEndpoint {
			t.Errorf("keyless request = %s %s", r.Method, r.URL)
		}
		if got := r.URL.Query().Get("query"); got != "go release" {
			t.Errorf("query = %q", got)
		}
		if r.Header.Get("X-API-Key") != "" {
			t.Error("keyless request must not send X-API-Key")
		}
		if got := r.Header.Get("User-Agent"); got != youComUserAgent {
			t.Errorf("User-Agent = %q", got)
		}
		fmt.Fprint(w, youComFixture)
	})
	searcher := newSearcher("youcom", "", "", "", "")
	text, citations, err := searcher.Search(t.Context(), "go release", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(citations) != 2 || citations[0].Snippet != "Release summary" || citations[1].Snippet != "Only a snippet." {
		t.Fatalf("citations = %#v", citations)
	}
	if citations[0].ThumbnailURL != "https://go.dev/thumb.png" {
		t.Fatalf("thumbnail = %q", citations[0].ThumbnailURL)
	}
	for _, want := range []string{"Go release notes", "First excerpt.", "(date: 2026-02-10T00:00:00)"} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}

func TestYouComKeyedRequestUsesPOST(t *testing.T) {
	for name, tc := range map[string]struct{ setting, env, want string }{
		"setting": {"setting-key", "env-key", "setting-key"},
		"env":     {"", "env-key", "env-key"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("YDC_API_KEY", tc.env)
			mockYouComHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.String() != youComKeyedEndpoint {
					t.Errorf("keyed request = %s %s", r.Method, r.URL)
				}
				if got := r.Header.Get("X-API-Key"); got != tc.want {
					t.Errorf("X-API-Key = %q, want %q", got, tc.want)
				}
				var body map[string]any
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil || body["query"] != "q" || body["count"] != float64(3) {
					t.Errorf("body = %s", raw)
				}
				fmt.Fprint(w, youComFixture)
			})
			if _, _, err := newSearcher("you", tc.setting, "", "", "").Search(t.Context(), "q", 3); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestYouComErrorStatuses(t *testing.T) {
	t.Setenv("YDC_API_KEY", "")
	for status, want := range map[int]string{
		http.StatusUnauthorized:    "API key was rejected",
		http.StatusForbidden:       "API key was rejected",
		http.StatusPaymentRequired: "100 searches a day per IP",
		http.StatusTooManyRequests: "retry after 1h0m0s",
	} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			mockYouComHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.Header().Set("Retry-After", "3600")
				w.WriteHeader(status)
			})
			_, _, err := newSearcher("youcom", "", "", "", "").Search(t.Context(), "q", 3)
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("err = %v, want %q", err, want)
			}
			if calls != 1 {
				t.Fatalf("calls = %d, want 1", calls)
			}
		})
	}
}

func TestYouComRetriesShortRetryAfter(t *testing.T) {
	t.Setenv("YDC_API_KEY", "")
	previous := youComMaxRetryAfter
	youComMaxRetryAfter = time.Second
	t.Cleanup(func() { youComMaxRetryAfter = previous })
	calls := 0
	mockYouComHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		fmt.Fprint(w, youComFixture)
	})
	_, citations, err := newSearcher("youcom", "", "", "", "").Search(t.Context(), "q", 3)
	if err != nil || len(citations) != 2 || calls != 2 {
		t.Fatalf("err=%v citations=%d calls=%d", err, len(citations), calls)
	}
}

func TestYouComIsNotPickedByAuto(t *testing.T) {
	t.Setenv("YDC_API_KEY", "env-key")
	if _, ok := newSearcher("auto", "", "", "", "").(*youComSearcher); ok {
		t.Fatal("auto must not select You.com")
	}
}
