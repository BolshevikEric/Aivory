package api

import (
	"net/http"
	"strconv"

	"aivory/server/internal/store"
)

func listConversationSharesAdmin(d Deps, w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	filter := store.AdminConversationShareFilter{
		Search: query.Get("search"), UserID: query.Get("user_id"), UserQ: query.Get("user"),
	}
	total, err := store.CountAdminConversationShares(r.Context(), d.DB, filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	items, err := store.ListAdminConversationShares(r.Context(), d.DB, filter, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "limit": limit, "offset": offset,
	})
}
