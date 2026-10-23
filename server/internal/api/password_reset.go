package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"aivory/server/internal/mail"
	"aivory/server/internal/store"
)

func authEmailLocale(explicit string, r *http.Request, user *store.User) string {
	if locale := mail.NormalizeLocale(explicit); locale != "" {
		return locale
	}
	for _, part := range strings.Split(r.Header.Get("Accept-Language"), ",") {
		if locale := mail.NormalizeLocale(strings.Split(part, ";")[0]); locale != "" {
			return locale
		}
	}
	if user != nil {
		var settings struct {
			Language string `json:"language"`
		}
		if json.Unmarshal(user.Settings, &settings) == nil {
			if locale := mail.NormalizeLocale(settings.Language); locale != "" {
				return locale
			}
		}
	}
	return "en"
}

// Only configured application origins can receive an emailed reset secret.
// Never trust an arbitrary Host, Origin, callback or forwarding header.
func passwordResetOrigin(d Deps, r *http.Request) (string, error) {
	if strings.TrimSpace(d.Config.OAuthCallbackBaseURL) != "" {
		if origin, ok := normalizeOAuthOrigin(d.Config.OAuthCallbackBaseURL); ok {
			return origin, nil
		}
		return "", errors.New("invalid public application origin")
	}
	requested, _ := normalizeOAuthOrigin(r.Header.Get("Origin"))
	external, _ := normalizeOAuthOrigin(externalBaseURL(r))
	var fallback, externalMatch string
	for _, raw := range d.Config.AllowedOrigins {
		origin, ok := normalizeOAuthOrigin(raw)
		if !ok {
			continue
		}
		if origin == requested {
			return origin, nil
		}
		if origin == external {
			externalMatch = origin
		}
		if fallback == "" {
			fallback = origin
		}
	}
	if externalMatch != "" {
		return externalMatch, nil
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", errors.New("configure ALLOWED_ORIGINS or OAUTH_CALLBACK_BASE_URL for password recovery")
}

type passwordResetGrant struct {
	UserID    string `json:"user_id"`
	TokenVer  int    `json:"token_ver"`
	ExpiresAt int64  `json:"expires_at"`
}

var passwordResetTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func passwordResetKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "reset-link:" + hex.EncodeToString(sum[:])
}

func sendPasswordResetLink(d Deps, r *http.Request, user *store.User, locale string) error {
	if d.Cache == nil || d.Mailer == nil {
		return errors.New("password recovery unavailable")
	}
	origin, err := passwordResetOrigin(d, r)
	if err != nil {
		return err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return errors.New("generate password reset token")
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	key := passwordResetKey(token)
	grant, _ := json.Marshal(passwordResetGrant{UserID: user.ID, TokenVer: user.TokenVer, ExpiresAt: time.Now().Add(passwordResetCodeTTL).Unix()})
	d.Cache.Set(key, string(grant), passwordResetCodeTTL)
	// Retain the configured legacy TTL environment variable for upgrades.
	// Fragments are not sent to web servers or included in Referer headers.
	link := origin + "/reset-password?lang=" + url.QueryEscape(locale) + "#token=" + token
	if err := d.Mailer.SendAuth(user.Email, mail.AuthMessage{Purpose: "reset", Locale: locale, ResetURL: link, ExpiresIn: passwordResetCodeTTL}); err != nil {
		d.Cache.CompareAndDelete(key, string(grant))
		// SMTP errors must never expose the reset URL or token to logs.
		return errors.New("password reset email delivery failed")
	}
	return nil
}

// Existing and nonexistent accounts share the same response and cooldown.
func forgotPasswordHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	if !requirePasswordLoginEnabled(d, w) {
		return
	}
	var req struct {
		Email  string `json:"email"`
		Locale string `json:"locale"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Email == "" {
		writeError(w, 400, errInvalidInput)
		return
	}
	email, err := store.NormalizeUserEmail(req.Email)
	if err != nil {
		writeError(w, 400, errInvalidEmail)
		return
	}
	retryAfter, allowed := reserveEmailSend(d, email, "reset")
	if !allowed {
		writeEmailCooldown(w, retryAfter)
		return
	}
	if user, err := store.FindUserByEmail(r.Context(), d.DB, email); err == nil && user != nil {
		if err := sendPasswordResetLink(d, r, user, authEmailLocale(req.Locale, r, user)); err != nil {
			d.Logger.Printf("[mail] failed to send password reset email: %v", err)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "retry_after": retryAfter})
}

func resetPasswordHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	if !requirePasswordLoginEnabled(d, w) {
		return
	}
	var req struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Token == "" || req.NewPassword == "" {
		writeError(w, 400, errInvalidInput)
		return
	}
	if err := validateNewPassword(req.NewPassword, minimumPasswordLength); err != nil {
		writeError(w, 400, err)
		return
	}
	if !passwordResetTokenPattern.MatchString(req.Token) || d.Cache == nil {
		writeError(w, 400, errInvalidOrExpiredResetLink)
		return
	}
	key := passwordResetKey(req.Token)
	raw, ok := d.Cache.Get(key)
	var grant passwordResetGrant
	if !ok || json.Unmarshal([]byte(raw), &grant) != nil || grant.ExpiresAt <= time.Now().Unix() {
		writeError(w, 400, errInvalidOrExpiredResetLink)
		return
	}
	// Read the password before the user version. A concurrent password change
	// is caught either by this version check or the conditional database UPDATE.
	currentHash, err := store.PasswordFor(r.Context(), d.DB, grant.UserID)
	if err != nil {
		writeError(w, 400, errInvalidOrExpiredResetLink)
		return
	}
	user, err := store.FindUserByID(r.Context(), d.DB, grant.UserID)
	if err != nil || user.TokenVer != grant.TokenVer {
		writeError(w, 400, errInvalidOrExpiredResetLink)
		return
	}
	hash, err := store.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, 500, fmt.Errorf("hash password: %w", err))
		return
	}
	// Only one concurrent redemption can consume this token.
	if !d.Cache.CompareAndDelete(key, raw) {
		writeError(w, 400, errInvalidOrExpiredResetLink)
		return
	}
	if err := store.UpdateUserPasswordIfCurrent(r.Context(), d.DB, user.ID, currentHash, hash); err != nil {
		if errors.Is(err, store.ErrPasswordChanged) || errors.Is(err, store.ErrNotFound) {
			writeError(w, 400, errInvalidOrExpiredResetLink)
		} else {
			writeError(w, 500, err)
		}
		return
	}
	setAuditActor(r, user)
	invalidateAuthUser(d, user.ID)
	d.Cache.Publish("user:"+user.ID+":kill", "password_reset")
	writeJSON(w, 200, map[string]bool{"ok": true})
}
