package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestAdminUsersGroupFilterSearchAndExpiry(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "admin-users-filter.db"))
	t.Cleanup(func() { _ = db.Close() })
	mustExec(t, db, `INSERT INTO user_groups(id,name,features) VALUES('group-alpha','Alpha','[]'),('group-beta','Beta','[]')`)
	for index, user := range []struct{ id, group string }{
		{"alice", "group-alpha"}, {"amy", "group-alpha"}, {"bob", "group-beta"},
		{"expired-beta", "group-alpha"}, {"expired-free", "group-alpha"},
	} {
		mustExec(t, db, `INSERT INTO users(id,email,name,password_hash,group_id,sort_order)
			VALUES(?,?,?,'h',?,?)`, user.id, user.id+"@example.test", user.id, user.group, index)
	}
	mustExec(t, db, `UPDATE users SET group_expires_at=?,previous_group_id='group-beta' WHERE id='expired-beta'`, time.Now().Unix()-1)
	mustExec(t, db, `UPDATE users SET group_expires_at=?,previous_group_id='' WHERE id='expired-free'`, time.Now().Unix()-1)
	for _, tc := range []struct {
		query string
		total int
		first string
		size  int
	}{
		{"?group_id=group-alpha", 2, "alice", 2},
		{"?group_id=group-alpha&limit=1&offset=1", 2, "amy", 1},
		{"?group_id=group-alpha&search=AMY%40EXAMPLE", 1, "amy", 1},
		{"?group_id=group-alpha&search=bob", 0, "", 0},
		{"?group_id=group-beta", 2, "bob", 2},
		{"?group_id=ug_free", 1, "expired-free", 1},
		{"?group_id=missing", 0, "", 0},
		{"?search=expired", 2, "expired-beta", 2},
		{"?group_id=group-alpha&limit=999&offset=-1", 2, "alice", 2},
	} {
		t.Run(tc.query, func(t *testing.T) {
			rec := httptest.NewRecorder()
			listUsersAdmin(Deps{DB: db}, rec, httptest.NewRequest(http.MethodGet, "/api/admin/users"+tc.query, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			page := decodeGroupUsersPage(t, rec)
			if page.Total != tc.total || len(page.Users) != tc.size {
				t.Fatalf("page=%+v want total=%d size=%d", page, tc.total, tc.size)
			}
			if tc.first != "" && page.Users[0].ID != tc.first {
				t.Fatalf("first=%s want=%s", page.Users[0].ID, tc.first)
			}
			if page.Offset < 0 || page.Limit > 200 {
				t.Fatalf("invalid pagination: %+v", page)
			}
		})
	}
}
