package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
)

func TestWebFetchSettingsDefaultsValidationAndMasking(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openMigrated(t, filepath.Join(t.TempDir(), "fetch-settings.db"))
	defer db.Close()
	d := Deps{DB: db, Config: config.Config{FetchAPIKey: "env-fetch-secret"}}
	t.Setenv("AIVORY_TOOLS_WEB_FETCH_JINA_BASE", "https://env-reader.example.test")
	read := func() map[string]json.RawMessage {
		t.Helper()
		rec := httptest.NewRecorder()
		adminSettingsGet(d, rec, httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil))
		var out map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(rec.Body.String(), "env-fetch-secret") {
			t.Fatal("GET leaked environment credential")
		}
		return out
	}
	patch := func(body string) int {
		rec := httptest.NewRecorder()
		adminSettingsSet(d, rec, httptest.NewRequest(http.MethodPatch, "/api/admin/settings", strings.NewReader(body)))
		return rec.Code
	}
	defaults := read()
	if string(defaults["fetch_provider"]) != `"builtin"` || string(defaults["fetch_jina_default_base_url"]) != `"https://env-reader.example.test"` || string(defaults["fetch_api_key"]) != `"••••••"` {
		t.Fatalf("defaults=%v", defaults)
	}
	for _, body := range []string{
		`{"fetch_provider":"unknown"}`, `{"fetch_provider":123}`, `{"fetch_jina_url_mode":"unknown"}`,
		`{"fetch_jina_base_url":"ftp://reader.example.test"}`, `{"fetch_jina_base_url":"https://user:pass@reader.example.test"}`, `{"fetch_jina_base_url":"https://reader.example.test?key=secret"}`, `{"fetch_jina_base_url":"https://reader.example.test#frag"}`, `{"fetch_jina_base_url":42}`,
	} {
		if status := patch(body); status != http.StatusBadRequest {
			t.Fatalf("invalid body=%s status=%d", body, status)
		}
	}
	if status := patch(`{"search_provider":"deepseek","fetch_provider":" AnySearch ","fetch_api_key":"  fetch-secret  ","fetch_jina_base_url":" https://reader.example.test/ ","fetch_jina_url_mode":" RAW "}`); status != http.StatusOK {
		t.Fatalf("valid patch status=%d", status)
	}
	for key, want := range map[string]string{"fetch_provider": `"anysearch"`, "fetch_api_key": `"fetch-secret"`, "fetch_jina_base_url": `"https://reader.example.test"`, "fetch_jina_url_mode": `"raw"`} {
		raw, err := store.GetSetting(db, key)
		if err != nil || string(raw) != want {
			t.Fatalf("%s=%s err=%v", key, raw, err)
		}
	}
	if string(read()["fetch_api_key"]) != `"••••••"` {
		t.Fatal("saved credential was not masked")
	}
	if status := patch(`{"fetch_api_key":"••••••"}`); status != http.StatusOK {
		t.Fatalf("mask patch=%d", status)
	}
	raw, _ := store.GetSetting(db, "fetch_api_key")
	if string(raw) != `"fetch-secret"` {
		t.Fatalf("mask overwrote key: %s", raw)
	}
	if status := patch(`{"fetch_api_key":""}`); status != http.StatusOK {
		t.Fatalf("clear key=%d", status)
	}
	if string(read()["fetch_api_key"]) != `""` {
		t.Fatal("explicitly cleared key fell back to environment")
	}
	for _, provider := range []string{"builtin", "deepseek", "anysearch"} {
		if status := patch(`{"fetch_provider":"` + provider + `"}`); status != http.StatusOK {
			t.Fatalf("provider=%s status=%d", provider, status)
		}
	}
}

func TestDeepSeekSearchOnboardingRequiresKey(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openMigrated(t, filepath.Join(t.TempDir(), "deepseek-onboarding.db"))
	defer db.Close()
	deps := Deps{DB: db, Config: config.Config{SearchProvider: "deepseek"}}
	if ready, err := onboardingSearchReady(deps); err != nil || ready {
		t.Fatalf("missing key ready=%v err=%v", ready, err)
	}
	deps.Config.SearchAPIKey = "env-key"
	if ready, err := onboardingSearchReady(deps); err != nil || !ready {
		t.Fatalf("environment key ready=%v err=%v", ready, err)
	}
	if err := store.SetSetting(db, "search_api_key", ""); err != nil {
		t.Fatal(err)
	}
	if ready, err := onboardingSearchReady(deps); err != nil || ready {
		t.Fatalf("explicitly cleared key ready=%v err=%v", ready, err)
	}
}
