package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
)

func cachePasswordResetForTest(t *testing.T, d Deps, user *store.User, ttl time.Duration) string {
	t.Helper()
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	raw, _ := json.Marshal(passwordResetGrant{UserID: user.ID, TokenVer: user.TokenVer, ExpiresAt: time.Now().Add(ttl).Unix()})
	d.Cache.Set(passwordResetKey(token), string(raw), time.Minute)
	return token
}

func TestPasswordResetEmailsCarryWebsiteLocaleAndLink(t *testing.T) {
	for _, locale := range []string{"zh", "zh-Hant", "en", "ja", "fr"} {
		t.Run(locale, func(t *testing.T) {
			d, mailer := newEmailCooldownDeps(t)
			user, err := store.CreateUser(t.Context(), d.DB, "reset@example.test", "Reset", "old-hash")
			if err != nil {
				t.Fatal(err)
			}
			rec := runAuthJSONHandler(t, d, forgotPasswordHandler, "/api/auth/forgot-password", fmt.Sprintf(`{"email":%q,"locale":%q}`, user.Email, locale))
			if rec.Code != 200 || mailer.count() != 1 {
				t.Fatalf("status=%d sends=%d", rec.Code, mailer.count())
			}
			message := mailer.calls[0].message
			link, err := url.Parse(message.ResetURL)
			if err != nil {
				t.Fatal(err)
			}
			token := strings.TrimPrefix(link.Fragment, "token=")
			if message.Locale != locale || message.Code != "" || message.Purpose != "reset" || message.ExpiresIn != passwordResetCodeTTL || link.Scheme+"://"+link.Host != "https://app.example.test" || link.Path != "/reset-password" || link.Query().Get("lang") != locale || !passwordResetTokenPattern.MatchString(token) {
				t.Fatalf("incorrect reset email metadata for %s", locale)
			}
			if _, ok := d.Cache.Get(passwordResetKey(token)); !ok {
				t.Fatal("link grant missing")
			}
			if _, ok := d.Cache.Get("reset:" + user.Email); ok {
				t.Fatal("a six-digit reset code was issued")
			}
			if strings.Contains(rec.Body.String(), token) {
				t.Fatal("HTTP response exposed reset token")
			}
		})
	}
}

func TestPasswordResetOriginRejectsUntrustedHostAndOrigin(t *testing.T) {
	req := httptest.NewRequest("POST", "https://attacker.example.test/api/auth/forgot-password", nil)
	req.Header.Set("Origin", "https://attacker.example.test")
	req.Header.Set("X-Forwarded-Host", "attacker.example.test")
	d := Deps{Config: config.Config{AllowedOrigins: []string{"https://app.example.test", "https://other.example.test"}}}
	if got, err := passwordResetOrigin(d, req); err != nil || got != "https://app.example.test" {
		t.Fatalf("origin=%q err=%v", got, err)
	}
	req.Header.Set("Origin", "https://other.example.test")
	if got, _ := passwordResetOrigin(d, req); got != "https://other.example.test" {
		t.Fatalf("allowed origin=%q", got)
	}
	d.Config.OAuthCallbackBaseURL = "https://canonical.example.test"
	if got, _ := passwordResetOrigin(d, req); got != "https://canonical.example.test" {
		t.Fatalf("canonical origin=%q", got)
	}
	if _, err := passwordResetOrigin(Deps{}, req); err == nil {
		t.Fatal("unconfigured origin accepted untrusted host")
	}
}

func TestAuthEmailLocaleFollowsSelectionHeaderAndSavedPreference(t *testing.T) {
	user := &store.User{Settings: json.RawMessage(`{"language":"fr"}`)}
	req := httptest.NewRequest("POST", "/api/auth/forgot-password", nil)
	req.Header.Set("Accept-Language", "ja-JP,en;q=0.9")
	if got := authEmailLocale("zh-TW", req, user); got != "zh-Hant" {
		t.Fatalf("explicit language=%q", got)
	}
	if got := authEmailLocale("", req, user); got != "ja" {
		t.Fatalf("header language=%q", got)
	}
	req.Header.Del("Accept-Language")
	if got := authEmailLocale("", req, user); got != "fr" {
		t.Fatalf("saved language=%q", got)
	}
}

func TestVerificationResendUsesWebsiteLanguage(t *testing.T) {
	for _, locale := range []string{"zh", "zh-Hant", "en", "ja", "fr"} {
		t.Run(locale, func(t *testing.T) {
			d, mailer := newEmailCooldownDeps(t)
			if _, err := store.CreateUserWithState(t.Context(), d.DB, "pending@example.test", "Pending", "hash", "user", "pending", true); err != nil {
				t.Fatal(err)
			}
			rec := runAuthJSONHandler(t, d, sendCodeHandler, "/api/auth/send-code", fmt.Sprintf(`{"email":"pending@example.test","purpose":"verify","locale":%q}`, locale))
			if rec.Code != 200 || mailer.count() != 1 {
				t.Fatalf("status=%d sends=%d", rec.Code, mailer.count())
			}
			message := mailer.calls[0].message
			if message.Locale != locale || len(message.Code) != 6 || message.ResetURL != "" {
				t.Fatal("incorrect verification resend language or content")
			}
		})
	}
}

func TestPasswordResetRejectsOldCodesExpiredAndChangedPasswordLinks(t *testing.T) {
	d, _ := newEmailCooldownDeps(t)
	user, err := store.CreateUser(t.Context(), d.DB, "reset@example.test", "Reset", "old-hash")
	if err != nil {
		t.Fatal(err)
	}
	d.Cache.Set("reset:"+user.Email, "123456", time.Minute)
	old := runAuthJSONHandler(t, d, resetPasswordHandler, "/api/auth/reset-password", `{"email":"reset@example.test","code":"123456","new_password":"new-password123"}`)
	if old.Code != 400 {
		t.Fatalf("legacy code accepted: %d", old.Code)
	}
	expired := cachePasswordResetForTest(t, d, user, -time.Minute)
	valid := cachePasswordResetForTest(t, d, user, time.Minute)
	for _, token := range []string{expired, strings.Repeat("b", 43), "123456"} {
		rec := runAuthJSONHandler(t, d, resetPasswordHandler, "/api/auth/reset-password", fmt.Sprintf(`{"token":%q,"new_password":"new-password123"}`, token))
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "invalid_or_expired_reset_link") {
			t.Fatalf("invalid link status=%d body=%s", rec.Code, rec.Body.String())
		}
	}
	if _, ok := d.Cache.Get(passwordResetKey(valid)); !ok {
		t.Fatal("invalid guess burned valid link")
	}
	if err := store.UpdateUserPassword(t.Context(), d.DB, user.ID, "changed-hash"); err != nil {
		t.Fatal(err)
	}
	rec := runAuthJSONHandler(t, d, resetPasswordHandler, "/api/auth/reset-password", fmt.Sprintf(`{"token":%q,"new_password":"new-password123"}`, valid))
	if rec.Code != 400 {
		t.Fatalf("stale link accepted after password change: %d", rec.Code)
	}
}

func TestPasswordResetLinkConcurrentRedemption(t *testing.T) {
	d, _ := newEmailCooldownDeps(t)
	user, err := store.CreateUser(t.Context(), d.DB, "reset@example.test", "Reset", "old-hash")
	if err != nil {
		t.Fatal(err)
	}
	token := cachePasswordResetForTest(t, d, user, time.Minute)
	results := make(chan int, 4)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := runAuthJSONHandler(t, d, resetPasswordHandler, "/api/auth/reset-password", fmt.Sprintf(`{"token":%q,"new_password":"new-password123"}`, token))
			results <- rec.Code
		}()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for status := range results {
		if status == http.StatusOK {
			succeeded++
		} else if status != 400 {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful redemptions=%d, want 1", succeeded)
	}
	updated, _ := store.FindUserByID(t.Context(), d.DB, user.ID)
	if updated.TokenVer != user.TokenVer+1 {
		t.Fatal("token version must rotate exactly once")
	}
}
