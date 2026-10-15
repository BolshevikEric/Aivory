package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"aivory/server/internal/pdfexport"
	"aivory/server/internal/store"
)

const conversationPDFBodyLimit int64 = 16 << 20

func conversationPDFHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	allowed, err := store.CanManageConversationShare(r.Context(), d.DB, pathParam(r, "id"), authUser(r).ID)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	if !allowed {
		writeError(w, 404, errNotFound)
		return
	}
	var input struct {
		HTML string `json:"html"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, conversationPDFBodyLimit)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, errors.New("PDF input exceeds size limit"))
		} else {
			writeError(w, 400, err)
		}
		return
	}
	if strings.TrimSpace(input.HTML) == "" {
		writeError(w, 400, errors.New("empty PDF document"))
		return
	}
	if d.RenderPDF == nil {
		writeJSON(w, 503, map[string]string{"error": pdfexport.ErrUnavailable.Error()})
		return
	}
	data, err := d.RenderPDF(r.Context(), input.HTML)
	if err != nil {
		if errors.Is(err, pdfexport.ErrUnavailable) {
			writeJSON(w, 503, map[string]string{"error": pdfexport.ErrUnavailable.Error()})
		} else if errors.Is(err, pdfexport.ErrBusy) {
			writeError(w, 429, pdfexport.ErrBusy)
		} else {
			writeError(w, 500, errors.New("PDF rendering failed"))
		}
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="aivory-conversation.pdf"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
