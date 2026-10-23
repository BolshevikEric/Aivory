package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"aivory/server/internal/mail"
	"aivory/server/internal/store"
)

// Save the website language at signup so later server-side account events use
// the recipient's preference, rather than an administrator's or webhook's.
func saveSignupLocale(ctx context.Context, d Deps, user *store.User, locale string) {
	if updated, err := store.UpdateUserSettings(ctx, d.DB, user.ID, map[string]any{"language": locale}); err == nil {
		user.Settings = updated.Settings
	} else if d.Logger != nil {
		d.Logger.Printf("[mail] could not save signup language")
	}
}

func accountEmailURL(d Deps, r *http.Request, path, locale string) string {
	if r == nil {
		r = &http.Request{Header: make(http.Header), URL: &url.URL{}}
	}
	origin, err := passwordResetOrigin(d, r)
	if err != nil {
		return ""
	}
	return origin + path + "?lang=" + url.QueryEscape(locale)
}

func queueAccountEmail(d Deps, user *store.User, message mail.AuthMessage) {
	if d.Mailer == nil || user == nil || strings.HasSuffix(strings.ToLower(user.Email), "@oauth.local") {
		return
	}
	to, err := store.NormalizeUserEmail(user.Email)
	if err != nil {
		return
	}
	message.Name = user.Name
	// Snapshot everything before returning the request. SMTP never holds up
	// registration or a committed membership purchase, and errors cannot undo it.
	go func() {
		if err := d.Mailer.SendAuth(to, message); err != nil && d.Logger != nil {
			d.Logger.Printf("[mail] account notification delivery failed (%s)", message.Purpose)
		}
	}()
}

func queueWelcomeEmail(d Deps, r *http.Request, user *store.User, locale string) {
	queueAccountEmail(d, user, mail.AuthMessage{
		Purpose: "welcome", Locale: locale, AppURL: accountEmailURL(d, r, "/", locale),
	})
}

func queueMembershipEmail(d Deps, r *http.Request, user *store.User) {
	if d.Mailer == nil || user == nil || user.Status != "active" ||
		(user.GroupExpiresAt > 0 && user.GroupExpiresAt <= time.Now().Unix()) {
		return
	}
	group, err := store.GetUserGroup(r.Context(), d.DB, user.GroupID)
	if err != nil || group.IsDefault {
		return
	}
	locale := authEmailLocale("", &http.Request{Header: make(http.Header)}, user)
	queueAccountEmail(d, user, mail.AuthMessage{
		Purpose: "membership", Locale: locale, GroupName: group.Name,
		MembershipExpiresAt: user.GroupExpiresAt, AppURL: accountEmailURL(d, r, "/subscription", locale),
	})
}
