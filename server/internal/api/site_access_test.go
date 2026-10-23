package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aivory/server/internal/store"
)

func TestSiteAccessCloseAndReopen(t *testing.T) {
	d := newAuthSecurityDeps(t, "site-access.db")
	t.Cleanup(store.InvalidateConfig)
	hash, err := store.HashPassword("password123")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := store.CreateUserWithRole(t.Context(), d.DB, "operator@example.test", "Operator", hash, "admin")
	if err != nil {
		t.Fatal(err)
	}
	_, userToken := desktopTestUser(t, d)
	adminToken := issueBoundTestAccessToken(t, d.DB, d.Auth, admin)
	if _, err := store.CreateUserWithRole(t.Context(), d.DB, "reserve@example.test", "Reserve", "hash", "admin"); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(d)
	request := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	assertStatus := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status=%d body=%s, want %d", w.Code, w.Body.String(), status)
		}
	}

	assertStatus(request("GET", "/api/conversations", "", userToken), http.StatusOK)
	assertStatus(request("PATCH", "/api/admin/settings", `{"site_access":{"closed":true,"message":"  Maintenance\nPlease return later.  "}}`, adminToken), http.StatusOK)
	status := request("GET", "/api/public/site-status", "", "")
	assertStatus(status, http.StatusOK)
	var cfg siteAccessConfig
	if err := json.Unmarshal(status.Body.Bytes(), &cfg); err != nil || !cfg.Closed || cfg.Message != "Maintenance\nPlease return later." {
		t.Fatalf("unexpected status: %s", status.Body.String())
	}
	if !strings.Contains(status.Header().Get("Cache-Control"), "no-store") {
		t.Fatal("site status must not be cached")
	}
	for _, tc := range []struct{ method, path, token string }{
		{"GET", "/api/conversations", userToken},
		{"POST", "/api/files", userToken},
		{"GET", "/api/files/file-id", userToken},
		{"GET", "/api/public/shared/public-token", ""},
		{"GET", "/api/public/shared/public-token/files/file-id", ""},
		{"GET", "/api/public/maps/geocode?q=example", ""},
		{"POST", "/api/auth/register", ""},
		{"PATCH", "/api/admin/settings", userToken},
	} {
		w := request(tc.method, tc.path, `{}`, tc.token)
		assertStatus(w, http.StatusServiceUnavailable)
		if !strings.Contains(w.Body.String(), `"error":"site_closed"`) || w.Header().Get("Retry-After") == "" {
			t.Fatalf("closure response: %s", w.Body.String())
		}
	}
	// Authentication/recovery and settlement must reach their own handlers.
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/health"}, {"POST", "/api/auth/session"},
		{"POST", "/api/auth/login"}, {"POST", "/api/auth/forgot-password"},
		{"GET", "/api/payments/webhooks/missing"},
	} {
		w := request(tc.method, tc.path, `{}`, "")
		if strings.Contains(w.Body.String(), "site_closed") {
			t.Fatalf("must remain reachable: %s %s", tc.method, tc.path)
		}
	}
	// Cookie sessions have the same admin bypass as bearer authentication.
	r := httptest.NewRequest("GET", "/api/admin/settings", nil)
	r.AddCookie(&http.Cookie{Name: "auth_token", Value: adminToken})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	assertStatus(w, http.StatusOK)
	assertStatus(request("GET", "/api/me", "", userToken), http.StatusOK)
	assertStatus(request("GET", "/api/conversations", "", adminToken), http.StatusOK)
	assertStatus(request("GET", "/api/conversations", "", "invalid-token"), http.StatusUnauthorized)

	// A cached admin profile and an old JWT role cannot retain the bypass.
	if err := store.SetUserRole(t.Context(), d.DB, admin.ID, "user"); err != nil {
		t.Fatal(err)
	}
	assertStatus(request("GET", "/api/admin/settings", "", adminToken), http.StatusServiceUnavailable)
	if err := store.SetUserRole(t.Context(), d.DB, admin.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStatus(t.Context(), d.DB, admin.ID, "banned"); err != nil {
		t.Fatal(err)
	}
	assertStatus(request("GET", "/api/admin/settings", "", adminToken), http.StatusServiceUnavailable)
	if err := store.SetUserStatus(t.Context(), d.DB, admin.ID, "active"); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeAllUserSessions(t.Context(), d.DB, admin.ID); err != nil {
		t.Fatal(err)
	}
	assertStatus(request("GET", "/api/admin/settings", "", adminToken), http.StatusServiceUnavailable)
	login := request("POST", "/api/auth/login", `{"email":"operator@example.test","password":"password123"}`, "")
	assertStatus(login, http.StatusOK)
	var session struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil || session.AccessToken == "" {
		t.Fatalf("admin login must issue a session during closure: %s", login.Body.String())
	}
	adminToken = session.AccessToken
	assertStatus(request("PATCH", "/api/admin/settings", `{"site_access":{"closed":false,"message":"Private draft"}}`, adminToken), http.StatusOK)
	assertStatus(request("GET", "/api/conversations", "", userToken), http.StatusOK)
	status = request("GET", "/api/public/site-status", "", "")
	assertStatus(status, http.StatusOK)
	if strings.Contains(status.Body.String(), "Private draft") {
		t.Fatal("open site must not expose the draft closure message")
	}
}

func TestSiteAccessValidationAndRecovery(t *testing.T) {
	d := newAuthSecurityDeps(t, "site-access-validation.db")
	t.Cleanup(store.InvalidateConfig)
	for _, raw := range []string{
		`null`, `[]`, `true`, `{"closed":"yes"}`, `{"message":42}`,
		`{"closed":null}`, `{"message":null}`, `{"unknown":true}`,
		`{"message":"` + strings.Repeat("文", 2001) + `"}`,
	} {
		if _, err := applyAdminSettingsPatch(t.Context(), d, map[string]json.RawMessage{siteAccessSettingKey: json.RawMessage(raw)}, false, ""); err == nil {
			t.Fatalf("accepted invalid site setting: %.80s", raw)
		}
	}
	admin, err := store.CreateUserWithRole(t.Context(), d.DB, "recovery@example.test", "Recovery", "hash", "admin")
	if err != nil {
		t.Fatal(err)
	}
	token := issueBoundTestAccessToken(t, d.DB, d.Auth, admin)
	// A malformed config imported by an older server must not lock out repair.
	if err := store.SetSetting(d.DB, siteAccessSettingKey, "malformed"); err != nil {
		t.Fatal(err)
	}
	called := false
	h := siteAccessMiddleware(d, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(204) }))
	w := desktopTestRequest(d, h.ServeHTTP, "GET", "/api/admin/settings", "", token)
	if !called || w.Code != 204 {
		t.Fatalf("admin cannot repair malformed setting: %d %s", w.Code, w.Body.String())
	}
	called = false
	w = desktopTestRequest(d, h.ServeHTTP, "GET", "/api/conversations", "", "")
	if called || w.Code != 503 {
		t.Fatal("malformed closure config must not expose content")
	}
}
