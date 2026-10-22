package tools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
	"aivory/server/internal/tooldiagnostics"
)

func TestConfiguredWebReadersUseExactPayloadAndPreserveContent(t *testing.T) {
	for _, provider := range []string{"deepseek", "anysearch"} {
		t.Run(provider, func(t *testing.T) {
			var calls int
			tool := &webFetchTool{cfg: config.Config{FetchProvider: provider, FetchAPIKey: " reader-key "}, reader: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				endpoint := deepSeekFetchEndpoint
				if provider == "anysearch" {
					endpoint = anySearchExtractEndpoint
				}
				if req.URL.String() != endpoint || req.Method != http.MethodPost || req.Header.Get("Authorization") != "Bearer reader-key" || req.Header.Get("Content-Type") != "application/json" {
					t.Fatalf("unexpected request %s %s", req.Method, req.URL)
				}
				var body map[string]any
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if len(body) != 1 || body["url"] != "https://1.1.1.1/article" {
					t.Fatalf("payload=%v", body)
				}
				response := `{"title":"Article","content":"# Body\nUseful text\n![Photo](/photo.jpg)"}`
				if provider == "anysearch" {
					response = `{"code":0,"message":"success","data":` + response + `}`
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(response))}, nil
			})}
			out, cites, err := tool.Execute(context.Background(), []byte(`{"url":"https://1.1.1.1/article","show_images":true}`), nil)
			if err != nil || calls != 1 || !strings.Contains(out, "Useful text") || !strings.Contains(out, "Title: Article") || len(cites) != 1 || cites[0].ImageURL != "https://1.1.1.1/photo.jpg" {
				t.Fatalf("output=%s cites=%+v err=%v calls=%d", out, cites, err, calls)
			}
		})
	}
}

func TestConfiguredWebReadersRejectPrivateAndInvalidURLs(t *testing.T) {
	for _, provider := range []string{"deepseek", "anysearch"} {
		tool := &webFetchTool{cfg: config.Config{FetchProvider: provider, FetchAPIKey: "key"}, reader: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			t.Fatalf("unsafe target reached provider %s", req.URL)
			return nil, nil
		})}
		for _, target := range []string{"http://127.0.0.1/private", "http://192.168.1.1/private", "http://[::1]/", "http://localhost/", "http://service.local/", "http://user:password@1.1.1.1/", "http://1.1.1.1:8080/", "file:///etc/passwd", "https:///missing", "https://1.1.1.1/" + strings.Repeat("a", 8192)} {
			input, _ := json.Marshal(map[string]string{"url": target})
			if _, _, err := tool.Execute(context.Background(), input, nil); err == nil {
				t.Fatalf("%s accepted unsafe URL %q", provider, target)
			}
		}
	}
}

func TestAnySearchExtractErrorsNeverExposeQuotaCredentials(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{
		{402, `{"code":-1,"message":"generated-password generated-api-key"}`},
		{401, `{"error":"generated-api-key"}`},
		{200, `{"code":-1,"message":"generated-api-key"}`},
		{200, `{"code":0,"data":{"content":""}}`},
		{200, `{"code":0,"data":{}}`},
		{200, `{"code":0,"data":{"content":"` + strings.Repeat("a", webProviderJSONLimit) + `"}}`},
	} {
		tool := &webFetchTool{cfg: config.Config{FetchProvider: "anysearch"}, reader: statusTransport{code: tc.status, body: tc.body}}
		ctx, diagnostics := tooldiagnostics.Start(context.Background(), true)
		out, _, err := tool.Execute(ctx, []byte(`{"url":"https://1.1.1.1/page"}`), nil)
		if err == nil || strings.Contains(out+err.Error(), "generated-") {
			t.Fatalf("status=%d out=%s err=%v", tc.status, out, err)
		}
		if tc.status == 402 {
			requests, issues, _ := diagnostics.Snapshot()
			encoded, _ := json.Marshal([]any{requests, issues})
			if strings.Contains(string(encoded), "generated-") {
				t.Fatalf("quota credentials leaked to diagnostics: %s", encoded)
			}
		}
	}
}

func TestWebReaderSettingsReloadAndKeepSearchIndependent(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openToolsTestDB(t)
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_BASE", "https://reader-env.example.test")
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_URL_MODE", "raw")
	tool := &webFetchTool{db: db, cfg: config.Config{FetchAPIKey: "env-fetch-key"}}
	initial := tool.resolveConfig()
	if initial.provider != "builtin" || initial.jinaBase != "https://reader-env.example.test" || initial.jinaMode != "raw" {
		t.Fatalf("defaults=%+v", initial)
	}
	for key, value := range map[string]string{"fetch_provider": "deepseek", "fetch_api_key": "saved-fetch-key", "search_provider": "anysearch", "search_api_key": "search-only", "fetch_jina_base_url": "https://saved-reader.example.test", "fetch_jina_url_mode": "escaped"} {
		if err := store.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}
	updated := tool.resolveConfig()
	if updated.provider != "deepseek" || updated.apiKey != "saved-fetch-key" || updated.jinaBase != "https://saved-reader.example.test" || updated.jinaMode != "escaped" {
		t.Fatalf("saved=%+v", updated)
	}
	for _, key := range []string{"fetch_api_key", "fetch_jina_base_url", "fetch_jina_url_mode"} {
		if err := store.SetSetting(db, key, ""); err != nil {
			t.Fatal(err)
		}
	}
	cleared := tool.resolveConfig()
	if cleared.apiKey != "" || cleared.jinaBase != initial.jinaBase || cleared.jinaMode != initial.jinaMode {
		t.Fatalf("cleared=%+v", cleared)
	}
	if _, _, err := tool.Execute(context.Background(), []byte(`{"url":"https://1.1.1.1/page"}`), nil); err == nil || !strings.Contains(err.Error(), "API key") {
		t.Fatalf("cleared credential error=%v", err)
	}
}

func TestWebReaderBatchKeepsProviderUntilNextInvocation(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openToolsTestDB(t)
	if err := store.SetSetting(db, "fetch_provider", "deepseek"); err != nil {
		t.Fatal(err)
	}
	var change sync.Once
	endpoints := make(chan string, 3)
	tool := &webFetchTool{db: db, cfg: config.Config{FetchAPIKey: "test-key"}, reader: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		endpoints <- req.URL.String()
		change.Do(func() {
			if err := store.SetSetting(db, "fetch_provider", "anysearch"); err != nil {
				t.Error(err)
			}
		})
		body := `{"title":"Page","content":"Body"}`
		if req.URL.String() == anySearchExtractEndpoint {
			body = `{"code":0,"data":` + body + `}`
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	if _, _, err := tool.Execute(context.Background(), []byte(`{"urls":["https://1.1.1.1/one","https://1.1.1.1/two"]}`), nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if endpoint := <-endpoints; endpoint != deepSeekFetchEndpoint {
			t.Fatalf("batch switched provider mid-call: %s", endpoint)
		}
	}
	if _, _, err := tool.Execute(context.Background(), []byte(`{"url":"https://1.1.1.1/three"}`), nil); err != nil {
		t.Fatal(err)
	}
	if endpoint := <-endpoints; endpoint != anySearchExtractEndpoint {
		t.Fatalf("next invocation did not reload: %s", endpoint)
	}
}

func TestBuiltinWebReaderUsesSavedJinaAddressAndMode(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openToolsTestDB(t)
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_FALLBACK", "true")
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_BASE", "https://environment-reader.example.test")
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_URL_MODE", "escaped")
	for key, value := range map[string]string{"fetch_jina_base_url": "https://saved-reader.example.test", "fetch_jina_url_mode": "raw"} {
		if err := store.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}
	tool := &webFetchTool{db: db, direct: errTransport{}, reader: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://saved-reader.example.test/https://1.1.1.1/page?q=one" {
			t.Fatalf("reader URL=%s", req.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("Saved reader content"))}, nil
	})}
	out, _, err := tool.Execute(context.Background(), []byte(`{"url":"https://1.1.1.1/page?q=one"}`), nil)
	if err != nil || !strings.Contains(out, "Saved reader content") {
		t.Fatalf("out=%s err=%v", out, err)
	}
}
