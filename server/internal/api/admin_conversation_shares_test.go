package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	authsvc "aivory/server/internal/auth"
	"aivory/server/internal/cache"
	"aivory/server/internal/store"
)

func TestAdminConversationSharesFiltersPaginationAndAccess(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "admin-conversation-shares.db"))
	t.Cleanup(func() { _ = db.Close() })
	mustExec(t, db, `INSERT INTO users(id,email,name,password_hash,role,status) VALUES
		('admin','admin@example.test','Admin','h','admin','active'),
		('alice','alice@example.test','Alice Example','h','user','active'),
		('bob','bob@example.test','Bob Example','h','user','active')`)
	for _, share := range []struct {
		id, user, title string
		created         int64
	}{
		{"sh_a", "alice", "Research plan", 100},
		{"sh_b", "alice", "Reading list", 100},
		{"sh_c", "bob", "Research notes", 200},
	} {
		conv, err := store.CreateConversation(t.Context(), db, store.Conversation{ID: "conv-" + share.id, UserID: share.user, Title: share.title})
		if err != nil {
			t.Fatal(err)
		}
		mustExec(t, db, `INSERT INTO conversation_shares(id,conversation_id,user_id,title,snapshot,created_at)
			VALUES(?,?,?,?,?,?)`, share.id, conv.ID, share.user, share.title, `[{"text":"snapshot-private-content"}]`, share.created)
	}
	c := cache.NewMemory()
	d := Deps{DB: db, Cache: c, Auth: authsvc.New("admin-share-test-secret-32-bytes", time.Hour, 24*time.Hour, c)}
	issue := func(id string) string {
		t.Helper()
		user, err := store.FindUserByID(t.Context(), db, id)
		if err != nil {
			t.Fatal(err)
		}
		c.Set("seen:"+id, "1", time.Minute)
		return issueBoundTestAccessToken(t, db, d.Auth, user)
	}
	adminToken, userToken := issue("admin"), issue("alice")
	mx := newMux()
	mx.handle(http.MethodGet, "/api/admin/conversation-shares", requireAdmin(d, listConversationSharesAdmin))
	get := func(query, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/conversation-shares"+query, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		mx.ServeHTTP(rec, req)
		return rec
	}
	for _, tc := range []struct {
		name, token string
		status      int
	}{{"anonymous", "", http.StatusUnauthorized}, {"ordinary user", userToken, http.StatusForbidden}} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := get("", tc.token); rec.Code != tc.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
	for _, tc := range []struct {
		name, query string
		total, size int
		first       string
	}{
		{"all", "", 3, 3, "sh_c"},
		{"second page stable order", "?limit=1&offset=1", 3, 1, "sh_b"},
		{"name", "?user=ALICE+EXAMPLE", 2, 2, "sh_b"},
		{"email", "?user=BOB%40EXAMPLE", 1, 1, "sh_c"},
		{"user ID", "?user=alice", 2, 2, "sh_b"},
		{"exact user ID", "?user_id=bob", 1, 1, "sh_c"},
		{"combined", "?user_id=alice&search=RESEARCH", 1, 1, "sh_a"},
		{"share ID", "?search=sh_b", 1, 1, "sh_b"},
		{"conversation ID", "?search=conv-sh_a", 1, 1, "sh_a"},
		{"empty", "?user_id=missing", 0, 0, ""},
		{"beyond last page", "?offset=50", 3, 0, ""},
		{"parameterized user", "?user_id=alice%27+OR+1%3D1--", 0, 0, ""},
		{"bounds", "?limit=900&offset=-1", 3, 3, "sh_c"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(tc.query, adminToken)
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var page struct {
				Items  []store.AdminConversationShare `json:"items"`
				Total  int                            `json:"total"`
				Limit  int                            `json:"limit"`
				Offset int                            `json:"offset"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			if page.Total != tc.total || len(page.Items) != tc.size || page.Items == nil {
				t.Fatalf("page=%+v", page)
			}
			if tc.first != "" && page.Items[0].ID != tc.first {
				t.Fatalf("first=%s want=%s", page.Items[0].ID, tc.first)
			}
			if strings.Contains(rec.Body.String(), "snapshot") {
				t.Fatalf("list included frozen transcript: %s", rec.Body.String())
			}
			if tc.name == "bounds" && (page.Limit != 200 || page.Offset != 0) {
				t.Fatalf("bounds=%+v", page)
			}
			if tc.name == "all" && (page.Items[0].UserEmail != "bob@example.test" || page.Items[0].UserName != "Bob Example") {
				t.Fatalf("publisher identity=%+v", page.Items[0])
			}
		})
	}
}
