package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"aivory/server/internal/store"
)

const siteAccessSettingKey = "site_access"

type siteAccessConfig struct {
	Closed  bool   `json:"closed"`
	Message string `json:"message"`
}

func normalizeSiteAccess(raw json.RawMessage) (siteAccessConfig, error) {
	var cfg siteAccessConfig
	// Null fields must not silently reset a closure toggle during an import.
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return cfg, errInvalidInput
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return cfg, errInvalidInput
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cfg) != nil || utf8.RuneCountInString(cfg.Message) > 2000 {
		return cfg, errInvalidInput
	}
	cfg.Message = strings.TrimSpace(cfg.Message)
	return cfg, nil
}

func loadSiteAccess(d Deps) (siteAccessConfig, error) {
	raw, err := store.GetSetting(d.DB, siteAccessSettingKey)
	if errors.Is(err, sql.ErrNoRows) {
		return siteAccessConfig{}, nil
	}
	if err != nil {
		return siteAccessConfig{}, err
	}
	return normalizeSiteAccess(raw)
}

func publicSiteStatus(d Deps, w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", noStoreCacheControl)
	cfg, err := loadSiteAccess(d)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !cfg.Closed {
		cfg.Message = ""
	}
	writeJSON(w, http.StatusOK, cfg)
}

// Keep authentication, recovery and payment settlement reachable. All content
// (including public shares, files and map proxies) is closed by default.
func siteAccessExempt(r *http.Request) bool {
	p := r.URL.Path
	if strings.HasPrefix(p, "/api/auth/") {
		return p != "/api/auth/register"
	}
	if strings.HasPrefix(p, "/api/payments/webhooks/") {
		return true
	}
	switch p {
	case "/api/health", "/api/public/site-status", "/api/public/needs-setup", "/api/setup",
		"/api/public/signup-open", "/api/public/captcha", "/api/public/captcha/verify",
		"/api/public/oauth-providers", "/api/public/auth-policy", "/api/public/legal-config":
		return true
	case "/api/me":
		return r.Method == http.MethodGet
	}
	// These are still protected by requireAuth and their existing validation.
	return initialPasswordSetupRequest(r)
}

func siteAccessMiddleware(d Deps, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if siteAccessExempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		cfg, err := loadSiteAccess(d)
		if (err != nil || cfg.Closed) && siteAccessAdmin(d, r) {
			next.ServeHTTP(w, r)
			return
		}
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
		if !cfg.Closed {
			next.ServeHTTP(w, r)
			return
		}
		// Preserve the normal token-refresh path for an administrator whose
		// access token expired while this tab was open.
		if token := readAccessToken(r); token != "" {
			if _, err := d.Auth.ParseAccess(token); err != nil {
				writeError(w, http.StatusUnauthorized, errSessionExpired)
				return
			}
		}
		w.Header().Set("Cache-Control", noStoreCacheControl)
		w.Header().Set("Retry-After", "30")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "site_closed", "closed": true, "message": cfg.Message,
		})
	})
}

// Authorization must use the live role and session state, never a cached
// profile or a role claimed by the client. The route still enforces its normal
// authentication, request signature and resource permissions after this gate.
func siteAccessAdmin(d Deps, r *http.Request) bool {
	claims, err := d.Auth.ParseAccess(readAccessToken(r))
	if err != nil {
		return false
	}
	state, err := store.GetUserAuthStateForSession(r.Context(), d.DB, claims.UID, claims.SessionID)
	return err == nil && state.Role == "admin" && state.Status == "active" &&
		state.TokenVer == claims.TV && state.SessionActive
}
