package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/pdfexport"
	"aivory/server/internal/store"
)

func TestConversationPDFChecksOwnershipAndReturnsPrivateFile(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "pdf.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash,name) VALUES('owner','owner@example.test','h','Owner'),('other','other@example.test','h','Other')`)
	conversation, err := store.CreateConversation(t.Context(), db, store.Conversation{UserID: "owner", Title: "Private PDF"})
	if err != nil {
		t.Fatal(err)
	}
	rendered := 0
	deps := Deps{DB: db, RenderPDF: func(ctx context.Context, html string) ([]byte, error) {
		rendered++
		if html != "<p>Selected only</p>" {
			t.Fatal(html)
		}
		return []byte("%PDF-test"), nil
	}}
	for _, user := range []string{"other", "owner"} {
		recorder := httptest.NewRecorder()
		request := userGroupPermissionRequest("POST", "/api/conversations/"+conversation.ID+"/export/pdf", &store.User{ID: user, Role: "user"}, map[string]string{"id": conversation.ID}, `{"html":"<p>Selected only</p>"}`)
		conversationPDFHandler(deps, recorder, request)
		expected := 404
		if user == "owner" {
			expected = 200
		}
		if recorder.Code != expected {
			t.Fatalf("%s status=%d body=%s", user, recorder.Code, recorder.Body.String())
		}
		if user == "owner" && (recorder.Header().Get("Content-Type") != "application/pdf" || recorder.Header().Get("Cache-Control") != "no-store") {
			t.Fatal(recorder.Header())
		}
	}
	if rendered != 1 {
		t.Fatalf("rendered=%d", rendered)
	}
	for _, test := range []struct {
		err    error
		status int
	}{{pdfexport.ErrUnavailable, 503}, {pdfexport.ErrBusy, 429}, {errors.New("private renderer detail"), 500}} {
		deps.RenderPDF = func(context.Context, string) ([]byte, error) { return nil, test.err }
		recorder := httptest.NewRecorder()
		conversationPDFHandler(deps, recorder, userGroupPermissionRequest("POST", "/", &store.User{ID: "owner"}, map[string]string{"id": conversation.ID}, `{"html":"test"}`))
		if recorder.Code != test.status || strings.Contains(recorder.Body.String(), "private renderer detail") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if test.status == 503 && !strings.Contains(recorder.Body.String(), "pdf_renderer_unavailable") {
			t.Fatal("client needs the public error code to explain missing renderer")
		}
	}
}

func TestConversationPDFRequestProofAcceptsEmbeddedResourcesWithinLimit(t *testing.T) {
	// Embedded fonts/images exceed the ordinary JSON limit. Only the exact PDF
	// route may use the larger limit, and its whole payload must remain signed.
	body := strings.Repeat("a", int(jsonRequestBodySizeCap)+1)
	digest := sha256.Sum256([]byte(body))
	for _, path := range []string{"/api/conversations/selected/export/pdf", "/api/conversations/selected"} {
		request := httptest.NewRequest("POST", path, strings.NewReader(body))
		_, err := verifiedRequestPayloadDigest(request, hex.EncodeToString(digest[:]))
		if path == "/api/conversations/selected/export/pdf" && err != nil {
			t.Fatal(err)
		}
		if path == "/api/conversations/selected" && err == nil {
			t.Fatal("ordinary JSON route exceeded its limit")
		}
	}
	tooLarge := strings.Repeat("a", int(conversationPDFBodyLimit)+1)
	digest = sha256.Sum256([]byte(tooLarge))
	request := httptest.NewRequest("POST", "/api/conversations/selected/export/pdf", strings.NewReader(tooLarge))
	if _, err := verifiedRequestPayloadDigest(request, hex.EncodeToString(digest[:])); err == nil {
		t.Fatal("oversized PDF request accepted")
	}
}

func TestConversationPDFHonorsBothGroupPermissions(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "pdf-permissions.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO user_groups(id,name,features,permissions) VALUES('pdf_group','PDF','[]','{"allow_sharing":false,"allow_conversation_export":true}')`)
	mustExec(t, db, `INSERT INTO users(id,email,name,password_hash,role,status,group_id) VALUES('member','member@example.test','Member','h','user','active','pdf_group')`)
	handler := requireCapabilityHandler(errSharingGroupPermission, func(p store.UserGroupPermissions) bool { return p.AllowSharing }, requireCapabilityHandler(errConversationExportGroupPermission, func(p store.UserGroupPermissions) bool { return p.AllowConversationExport }, func(d Deps, w http.ResponseWriter, r *http.Request) {
		t.Fatal("renderer reached despite denied permission")
	}))
	user := &store.User{ID: "member", Role: "user", GroupID: "pdf_group"}
	for _, permission := range []string{"sharing", "export"} {
		if permission == "export" {
			mustExec(t, db, `UPDATE user_groups SET permissions='{"allow_sharing":true,"allow_conversation_export":false}' WHERE id='pdf_group'`)
		}
		recorder := httptest.NewRecorder()
		handler(Deps{DB: db}, recorder, userGroupPermissionRequest("POST", "/", user, nil, ""))
		if recorder.Code != 403 {
			t.Fatalf("%s permission status=%d body=%s", permission, recorder.Code, recorder.Body.String())
		}
	}
}
