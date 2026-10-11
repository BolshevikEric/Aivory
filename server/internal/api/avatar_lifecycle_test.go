package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
)

func uploadLifecycleAvatar(t *testing.T, d Deps, userID string) (string, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	uploadAvatar(d, rec, uploadRequestWithFile(t, "/api/me/avatar", &store.User{ID: userID, Status: "active"}, "avatar.png", testAvatarPNG(t)))
	if rec.Code != 200 {
		t.Fatalf("upload=%d %s", rec.Code, rec.Body.String())
	}
	var result struct {
		URL      string `json:"url"`
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.URL, filepath.Join(d.Config.LocalStorageDir, "workspaces", "avatars", result.Filename)
}

func avatarHTTPStatus(d Deps, url string) int {
	mux := newMux()
	mux.handle("GET", "/api/avatars/:filename", func(w http.ResponseWriter, r *http.Request) { serveAvatar(d, w, r) })
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	return rec.Code
}

func TestAvatarLifecycleReplacementRemovalAndAccountDeletion(t *testing.T) {
	ctx := context.Background()
	db := openMigrated(t, filepath.Join(t.TempDir(), "avatars.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h'),('other','other@test','h')`)
	if err := store.SetSetting(db, "storage_provider", "local"); err != nil {
		t.Fatal(err)
	}
	d := Deps{DB: db, Config: config.Config{LocalStorageDir: t.TempDir()}}
	first, firstPath := uploadLifecycleAvatar(t, d, "u")
	if got := avatarHTTPStatus(d, first); got != 404 {
		t.Fatalf("unattached public avatar status=%d", got)
	}
	if _, err := store.UpdateUserSettings(ctx, db, "other", map[string]any{"avatar_url": first}); !errors.Is(err, store.ErrAvatarUnavailable) {
		t.Fatalf("another account attached avatar: %v", err)
	}
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": first}); err != nil {
		t.Fatal(err)
	}
	if got := avatarHTTPStatus(d, first); got != 200 {
		t.Fatalf("attached avatar status=%d", got)
	}
	second, secondPath := uploadLifecycleAvatar(t, d, "u")
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": second}); err != nil {
		t.Fatal(err)
	}
	if got := avatarHTTPStatus(d, first); got != 404 {
		t.Fatalf("replaced URL remains readable: %d", got)
	}
	sweepAvatarCleanup(ctx, d)
	if _, err := os.Stat(firstPath); !os.IsNotExist(err) {
		t.Fatalf("replaced object survives: %v", err)
	}
	if _, err := os.Stat(secondPath); err != nil {
		t.Fatal("cleanup deleted current avatar")
	}
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": ""}); err != nil {
		t.Fatal(err)
	}
	sweepAvatarCleanup(ctx, d)
	if _, err := os.Stat(secondPath); !os.IsNotExist(err) {
		t.Fatalf("removed object survives: %v", err)
	}
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": second}); !errors.Is(err, store.ErrAvatarUnavailable) {
		t.Fatalf("revoked URL can be reattached: %v", err)
	}
	third, thirdPath := uploadLifecycleAvatar(t, d, "u")
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": third}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteUser(ctx, db, "u"); err != nil {
		t.Fatal(err)
	}
	if got := avatarHTTPStatus(d, third); got != 404 {
		t.Fatalf("deleted account avatar remains public: %d", got)
	}
	sweepAvatarCleanup(ctx, d)
	if _, err := os.Stat(thirdPath); !os.IsNotExist(err) {
		t.Fatalf("deleted account object survives: %v", err)
	}
}

func TestAvatarUnattachedUploadsExpireAndFailedCleanupRetries(t *testing.T) {
	ctx := context.Background()
	db := openMigrated(t, filepath.Join(t.TempDir(), "pending-avatars.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	if err := store.SetSetting(db, "storage_provider", "local"); err != nil {
		t.Fatal(err)
	}
	d := Deps{DB: db, Config: config.Config{LocalStorageDir: t.TempDir()}}
	url, path := uploadLifecycleAvatar(t, d, "u")
	// The settings save never completed. Active pending uploads remain available
	// for retry until the one-hour attachment window elapses.
	sweepAvatarCleanup(ctx, d)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `UPDATE avatar_objects SET expires_at=0`)
	// Force a real filesystem deletion failure (a nonempty directory).
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(path, "blocked")
	if err := os.WriteFile(child, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	sweepAvatarCleanup(ctx, d)
	var attempts int
	var lastError string
	if err := db.QueryRow(`SELECT attempts,last_error FROM avatar_objects`).Scan(&attempts, &lastError); err != nil || attempts != 1 || lastError == "" {
		t.Fatalf("cleanup failure lost: %d %q %v", attempts, lastError, err)
	}
	if _, err := store.UpdateUserSettings(ctx, db, "u", map[string]any{"avatar_url": url}); !errors.Is(err, store.ErrAvatarUnavailable) {
		t.Fatalf("expired upload can be attached: %v", err)
	}
	if err := os.Remove(child); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("retry"), 0600); err != nil {
		t.Fatal(err)
	}
	sweepAvatarCleanup(ctx, d)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("retry left avatar object: %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM avatar_objects`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("completed retry not removed: %d %v", count, err)
	}
}

func TestAvatarUploadCompletingAfterAccountDeletionIsDiscarded(t *testing.T) {
	ctx := context.Background()
	db := openMigrated(t, filepath.Join(t.TempDir(), "late-avatar.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	if err := store.SetSetting(db, "storage_provider", "local"); err != nil {
		t.Fatal(err)
	}
	d := Deps{DB: db, Config: config.Config{LocalStorageDir: t.TempDir()}}
	filename := "1234567890abcdef12345678.png"
	if err := store.RegisterAvatarUpload(ctx, db, "u", filename, time.Now().Add(time.Minute).Unix()); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteUser(ctx, db, "u"); err != nil {
		t.Fatal(err)
	}
	sweepAvatarCleanup(ctx, d)
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM avatar_objects`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("in-flight upload lost cleanup: %d %v", count, err)
	}
	if _, err := privateObjectStorage(d).Put(ctx, avatarObjectPrefix+filename, testAvatarPNG(t), "image/png"); err != nil {
		t.Fatal(err)
	}
	if err := store.FinishAvatarUpload(ctx, db, filename, true); !errors.Is(err, store.ErrAvatarUnavailable) {
		t.Fatalf("deleted account upload accepted: %v", err)
	}
	sweepAvatarCleanup(ctx, d)
	if _, err := privateObjectStorage(d).Get(ctx, avatarObjectPrefix+filename, maxIconBytes); err == nil {
		t.Fatal("late avatar survived deletion")
	}
}
