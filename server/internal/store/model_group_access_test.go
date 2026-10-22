package store

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestModelGroupAccessPersistenceAndCurrentMembership(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "model-group-access.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO channels(id,name,type) VALUES('access-channel','Access','openai')`,
		`INSERT INTO user_groups(id,name) VALUES('restricted','Restricted'),('allowed','Allowed')`,
		`INSERT INTO users(id,email,password_hash,role,group_id) VALUES('member','member@example.test','h','user','restricted'),('admin','admin@example.test','h','admin','restricted')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	model, err := CreateModel(ctx, db, Model{ChannelID: "access-channel", Kind: "chat", RequestID: "access", Label: "Access", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckModelGroupAccess(ctx, db, "member", model); err != nil {
		t.Fatalf("default allow: %v", err)
	}
	model.DeniedGroupIDs = []string{" restricted ", "restricted"}
	model, err = UpdateModel(ctx, db, model.ID, *model)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(model.DeniedGroupIDs, []string{"restricted"}) {
		t.Fatalf("policy=%v", model.DeniedGroupIDs)
	}
	for _, lookup := range []func() (*Model, error){
		func() (*Model, error) { return GetModel(ctx, db, model.ID) },
		func() (*Model, error) { return GetModelByChannelRequestID(ctx, db, model.ChannelID, model.RequestID) },
	} {
		loaded, err := lookup()
		if err != nil {
			t.Fatal(err)
		}
		if err := CheckModelGroupAccess(ctx, db, "member", loaded); !errors.Is(err, ErrModelGroupAccess) {
			t.Fatalf("restricted member: %v", err)
		}
		if err := CheckModelGroupAccess(ctx, db, "admin", loaded); err != nil {
			t.Fatalf("system admin: %v", err)
		}
		if err := CheckModelGroupAccess(ctx, db, "missing", loaded); err == nil {
			t.Fatal("missing user was allowed")
		}
	}
	models, err := ListModels(ctx, db, "chat", true)
	if err != nil {
		t.Fatal(err)
	}
	filtered, err := FilterModelsByUserGroup(ctx, db, "member", models)
	if err != nil || len(filtered) != 0 {
		t.Fatalf("filtered=%v err=%v", filtered, err)
	}
	if _, err := db.Exec(`UPDATE users SET group_id='allowed' WHERE id='member'`); err != nil {
		t.Fatal(err)
	}
	if err := CheckModelGroupAccess(ctx, db, "member", model); err != nil {
		t.Fatalf("current membership ignored: %v", err)
	}
	if _, err := db.Exec(`UPDATE users SET group_expires_at=?,previous_group_id='restricted' WHERE id='member'`, time.Now().Unix()-1); err != nil {
		t.Fatal(err)
	}
	if err := CheckModelGroupAccess(ctx, db, "member", model); !errors.Is(err, ErrModelGroupAccess) {
		t.Fatalf("expired membership: %v", err)
	}
	model.DeniedGroupIDs = []string{}
	model, err = UpdateModel(ctx, db, model.ID, *model)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckModelGroupAccess(ctx, db, "member", model); err != nil {
		t.Fatalf("reenabled: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent migration: %v", err)
	}
}

func TestModelGroupAccessRejectsInvalidPolicy(t *testing.T) {
	for _, ids := range [][]string{{""}, {" "}, make([]string, 1001)} {
		if _, err := NormalizeModelDeniedGroupIDs(ids); !errors.Is(err, ErrInvalidModelGroupAccess) {
			t.Fatalf("invalid policy accepted: %v", err)
		}
	}
}
