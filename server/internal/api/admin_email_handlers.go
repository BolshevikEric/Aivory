package api

import (
	"net/http"
	"time"

	"aivory/server/internal/mail"
)

func adminEmailPreview(d Deps, w http.ResponseWriter, r *http.Request) {
	message := mail.AuthMessage{
		Purpose: r.URL.Query().Get("purpose"), Locale: r.URL.Query().Get("locale"),
		Name: "Alex", Code: "123456", ExpiresIn: emailVerificationCodeTTL,
		AppURL: "https://example.com/", ResetURL: "https://example.com/reset-password#token=preview",
		GroupName: "Pro", MembershipExpiresAt: time.Now().Add(30 * 24 * time.Hour).Unix(),
	}
	if message.Purpose == "reset" {
		message.ExpiresIn = passwordResetCodeTTL
	}
	subject, body, err := mail.Preview(message)
	if err != nil {
		writeError(w, http.StatusBadRequest, errInvalidInput)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"subject": subject, "html": body})
}
