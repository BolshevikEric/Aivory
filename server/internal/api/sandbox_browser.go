package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"aivory/server/internal/sandbox"
	"aivory/server/internal/store"
)

func sandboxBrowserConversation(ctx context.Context, d Deps, id, userID string, admin bool) (*store.Conversation, error) {
	if admin {
		return store.GetConversationByID(ctx, d.DB, id)
	}
	return store.GetConversation(ctx, d.DB, id, userID)
}

func sandboxBrowserSession(conv *store.Conversation) string {
	var state struct {
		ID string `json:"sandbox_id"`
	}
	_ = json.Unmarshal(conv.ProviderState, &state)
	return state.ID
}

func sandboxBrowserBackend(d Deps) sandbox.Service {
	if d.Tools == nil {
		return nil
	}
	sb := d.Tools.Sandbox()
	if sb == nil || !sb.Enabled() {
		return nil
	}
	return sb
}

func sandboxArchiveReason(err error) string {
	switch {
	case errors.Is(err, sandbox.ErrArchiveMissing):
		return "archive_missing"
	case errors.Is(err, sandbox.ErrArchiveNotConfigured):
		return "archive_not_configured"
	case errors.Is(err, sandbox.ErrArchiveUnsupported):
		return "unsupported"
	case errors.Is(err, sandbox.ErrArchiveFileMissing):
		return "file_missing"
	default:
		return "archive_read_failed"
	}
}

func serveSandboxBrowserList(d Deps, w http.ResponseWriter, r *http.Request, userID string, admin bool) {
	id := pathParam(r, "id")
	conv, err := sandboxBrowserConversation(r.Context(), d, id, userID, admin)
	if err != nil {
		writeError(w, 404, errNotFound)
		return
	}
	sid := sandboxBrowserSession(conv)
	files := []sandbox.SandboxFile{}
	reason := ""
	archived := false
	if sid != "" {
		sb := sandboxBrowserBackend(d)
		if sb == nil {
			reason = "service_unavailable"
		} else {
			files, err = sb.ListFiles(r.Context(), sid)
			if sandbox.IsSessionGone(err) {
				browser, ok := sb.(sandbox.ArchiveBrowser)
				if !ok {
					reason = "unsupported"
				} else {
					files, err = browser.ListArchivedFiles(r.Context(), id, sid)
					if err != nil {
						reason = sandboxArchiveReason(err)
					} else {
						archived = true
					}
				}
			} else if err != nil {
				var httpErr *sandbox.HTTPError
				if errors.As(err, &httpErr) && httpErr.StatusCode == 404 {
					reason = "unsupported"
				} else {
					reason = "service_unavailable"
				}
			}
			if err != nil {
				logStorageCleanup(d, "sandbox browser %s: %v", id, err)
			}
		}
	}
	// The remote read can take time. A deletion or membership revocation during
	// it must not expose bytes or names to a principal who lost access.
	if _, err := sandboxBrowserConversation(r.Context(), d, id, userID, admin); err != nil {
		writeError(w, 404, errNotFound)
		return
	}
	if files == nil || reason != "" {
		files = []sandbox.SandboxFile{}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, 200, map[string]any{"session": sid, "files": files, "archived": archived, "unavailable": reason != "", "unavailable_reason": reason})
}

func serveSandboxBrowserFile(d Deps, w http.ResponseWriter, r *http.Request, userID string, admin bool) {
	id := pathParam(r, "id")
	path := r.URL.Query().Get("path")
	if !validSandboxFilePath(path) {
		writeError(w, 400, errInvalidInput)
		return
	}
	conv, err := sandboxBrowserConversation(r.Context(), d, id, userID, admin)
	if err != nil {
		writeError(w, 404, errNotFound)
		return
	}
	sid := sandboxBrowserSession(conv)
	if sid == "" {
		writeError(w, 404, errNotFound)
		return
	}
	sb := sandboxBrowserBackend(d)
	if sb == nil {
		writeJSON(w, 503, map[string]string{"error": "sandbox service unavailable", "code": "sandbox_service_unavailable"})
		return
	}
	data, err := sb.GetFile(r.Context(), sid, path)
	archived := false
	if sandbox.IsSessionGone(err) {
		browser, ok := sb.(sandbox.ArchiveBrowser)
		if !ok {
			err = sandbox.ErrArchiveUnsupported
		} else {
			data, err = browser.GetArchivedFile(r.Context(), id, sid, path)
			archived = true
		}
	}
	if _, accessErr := sandboxBrowserConversation(r.Context(), d, id, userID, admin); accessErr != nil {
		writeError(w, 404, errNotFound)
		return
	}
	if err != nil {
		status := http.StatusBadGateway
		var httpErr *sandbox.HTTPError
		if errors.Is(err, sandbox.ErrArchiveMissing) || errors.Is(err, sandbox.ErrArchiveFileMissing) || (errors.As(err, &httpErr) && httpErr.StatusCode == 404) {
			status = 404
		}
		logStorageCleanup(d, "sandbox file browser %s: %v", id, err)
		code := "sandbox_service_unavailable"
		if archived || errors.Is(err, sandbox.ErrArchiveUnsupported) {
			code = "sandbox_" + sandboxArchiveReason(err)
		}
		writeJSON(w, status, map[string]string{"error": "sandbox file unavailable", "code": code})
		return
	}
	if data == nil {
		writeError(w, 404, errNotFound)
		return
	}
	serveSandboxFile(w, path, data)
}
