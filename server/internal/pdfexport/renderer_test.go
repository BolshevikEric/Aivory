package pdfexport

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ledongthuc/pdf"
)

func TestRendererPrintsSearchablePaginatedPDFWithoutNetworkOrScripts(t *testing.T) {
	executable := os.Getenv("AIVORY_PDF_CHROME_PATH")
	if executable == "" {
		t.Skip("set AIVORY_PDF_CHROME_PATH for real Chromium integration")
	}
	var requests atomic.Int64
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); _, _ = w.Write([]byte("REMOTE SECRET")) }))
	defer remote.Close()
	renderer := New()
	defer renderer.Close()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	html := `<html><head><meta charset="utf-8"><style>p{font-size:16px}h1{color:#444}</style></head><body><h1>PDF content 中文测试</h1><script>document.body.innerHTML='SCRIPT EXECUTED'</script><img src="` + remote.URL + `/image"><iframe src="` + remote.URL + `/secret"></iframe>` + strings.Repeat("<p>Searchable paragraph with code and readable text.</p>", 100) + `<p>FINAL PARAGRAPH</p></body></html>`
	data, err := renderer.Render(ctx, html)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		t.Fatal("missing PDF signature")
	}
	document, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if document.NumPage() < 2 {
		t.Fatal("long content was not paginated")
	}
	// Chromium emits subset CID fonts; require their Unicode mappings. Actual
	// Chinese/English text extraction is covered by the browser PDF.js test.
	if !bytes.Contains(data, []byte("/ToUnicode")) {
		t.Fatal("missing searchable font mapping")
	}
	if requests.Load() != 0 {
		t.Fatalf("unsafe document network: requests=%d", requests.Load())
	}
	if directory := os.Getenv("AIVORY_PDF_TEST_OUTPUT_DIR"); directory != "" {
		if err := os.MkdirAll(directory, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "renderer-test.pdf"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	// A second request reuses the browser, but not the previous tab/document.
	second, err := renderer.Render(ctx, "<p>Isolated second export</p>")
	if err != nil || !bytes.HasPrefix(second, []byte("%PDF-")) {
		t.Fatalf("reuse failed: %v", err)
	}
}

func TestRendererBoundsConcurrencyAndHonorsCancellation(t *testing.T) {
	renderer := New()
	renderer.slots <- struct{}{}
	renderer.slots <- struct{}{}
	if _, err := renderer.Render(t.Context(), "<p>busy</p>"); err != ErrBusy {
		t.Fatalf("busy error=%v", err)
	}
	<-renderer.slots
	<-renderer.slots
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := renderer.Render(ctx, "<p>cancelled</p>"); err != context.Canceled {
		t.Fatalf("cancel error=%v", err)
	}
}
