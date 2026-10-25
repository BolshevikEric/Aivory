package store

import (
	"database/sql"
	"errors"
	"testing"
)

func TestRegistrationDomainWithoutWorkspace(t *testing.T) {
	fx := newRBACFixture(t)
	ctx := t.Context()
	initial, err := CreateUserGroup(ctx, fx.db, UserGroup{Name: "Domain signup group"})
	if err != nil {
		t.Fatal(err)
	}
	existing, err := CreateUser(ctx, fx.db, "existing@company.example", "Existing", "hash")
	if err != nil {
		t.Fatal(err)
	}
	rule := RegistrationDomain{Domain: "company.example", InitialGroupID: initial.ID, EmailVerificationRequired: true}
	if err := SaveRegistrationDomain(ctx, fx.db, rule, true); err != nil {
		t.Fatal(err)
	}
	if access, err := GetDomainAccess(ctx, fx.db, existing.ID); err != nil || access != nil {
		t.Fatalf("historical account auto-enrolled: %+v, %v", access, err)
	}
	user, err := CreateRegisteredUser(ctx, fx.db, "new@company.example", "New", "hash", "active")
	if err != nil {
		t.Fatal(err)
	}
	if user.GroupID != initial.ID {
		t.Fatalf("new user group = %q, want %q", user.GroupID, initial.ID)
	}
	if required, err := registrationDomainEmailVerificationRequired(ctx, fx.db, user.Email); err != nil || !required {
		t.Fatalf("verification policy = %v, %v", required, err)
	}
	if _, err := EnrollExistingDomainUsers(ctx, fx.db, rule.Domain, []string{existing.ID}); err != nil {
		t.Fatal(err)
	}
	if refreshed, err := FindUserByID(ctx, fx.db, existing.ID); err != nil || refreshed.GroupID != existing.GroupID {
		t.Fatalf("manual enrollment changed existing group: %+v, %v", refreshed, err)
	}
	for _, userID := range []string{user.ID, existing.ID} {
		access, err := GetDomainAccess(ctx, fx.db, userID)
		if err != nil || access == nil || access.WorkspaceID != "" || access.Locked {
			t.Fatalf("unassigned account access = %+v, %v", access, err)
		}
		var memberships int
		if err := fx.db.QueryRow(`SELECT COUNT(*) FROM workspace_members WHERE user_id=?`, userID).Scan(&memberships); err != nil || memberships != 0 {
			t.Fatalf("unassigned account joined %d workspaces: %v", memberships, err)
		}
		if _, err := CreateConversation(ctx, fx.db, Conversation{ID: "personal-" + userID, UserID: userID, Title: "Personal"}); err != nil {
			t.Fatal(err)
		}
		if status, err := GetDomainPersonalDataStatus(ctx, fx.db, userID); err != nil || status.NeedsAction || status.CanMigrate {
			t.Fatalf("unassigned account prompted to migrate personal data: %+v, %v", status, err)
		}
	}
	locked := true
	if err := UpdateDomainUserAccess(ctx, fx.db, rule.Domain, user.ID, &locked); !errors.Is(err, ErrDomainWorkspaceRequired) {
		t.Fatalf("individual lock without workspace = %v", err)
	}
	rule.LockPersonal = true
	if err := SaveRegistrationDomain(ctx, fx.db, rule, false); !errors.Is(err, ErrDomainWorkspaceRequired) {
		t.Fatalf("rule lock without workspace = %v", err)
	}
	rule.LockPersonal = false
	rule.Enabled = false
	rule.Domains = []string{"new.example"}
	rule.InitialGroupID = ""
	rule.SubscriptionPurchaseDisabled = true
	if err := SaveRegistrationDomain(ctx, fx.db, rule, false); err != nil {
		t.Fatal(err)
	}
	if access, err := GetDomainAccess(ctx, fx.db, user.ID); err != nil || access == nil || access.Domain != rule.Domain || !access.SubscriptionPurchaseDisabled || access.Locked {
		t.Fatalf("editing/stopping rule changed existing binding: %+v, %v", access, err)
	}
	if refreshed, err := FindUserByID(ctx, fx.db, user.ID); err != nil || refreshed.GroupID != initial.ID {
		t.Fatalf("editing initial group changed an existing member: %+v, %v", refreshed, err)
	}
	rules, err := ListRegistrationDomains(ctx, fx.db)
	if err != nil || len(rules) != 1 || rules[0].WorkspaceID != "" || rules[0].WorkspaceName != "" || rules[0].MemberCount != 2 {
		t.Fatalf("list unassigned rule = %+v, %v", rules, err)
	}
	rule.WorkspaceID = fx.workspaceID
	if err := SaveRegistrationDomain(ctx, fx.db, rule, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("existing target workspace must remain immutable: %v", err)
	}
	if removed, err := RemoveDomainUser(ctx, fx.db, rule.Domain, user.ID); err != nil || removed.WorkspaceMembershipRemoved || removed.WorkspaceID != "" {
		t.Fatalf("remove unassigned member = %+v, %v", removed, err)
	}
	if conversations, err := ListConversations(ctx, fx.db, user.ID, "", "", 10, 0); err != nil || len(conversations) != 1 {
		t.Fatalf("removing domain member changed personal data: %+v, %v", conversations, err)
	}
}

func TestRegistrationDomainOptionalWorkspaceMigrationPreservesBindings(t *testing.T) {
	fx := newRBACFixture(t)
	ctx := t.Context()
	rule := RegistrationDomain{Domain: "company.example", Domains: []string{"company.example", "affiliate.example"}, WorkspaceID: fx.workspaceID, LockPersonal: true, EmailVerificationRequired: true, SubscriptionPurchaseDisabled: true}
	if err := SaveRegistrationDomain(ctx, fx.db, rule, true); err != nil {
		t.Fatal(err)
	}
	user, err := CreateRegisteredUser(ctx, fx.db, "member@affiliate.example", "Member", "hash", "active")
	if err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-upgrade parent while keeping its dependent rows intact.
	exec(t, fx.db, `PRAGMA foreign_keys=OFF`)
	exec(t, fx.db, `CREATE TABLE registration_domains_legacy (
		domain TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
		lock_personal INTEGER NOT NULL DEFAULT 0, email_verification_required INTEGER NOT NULL DEFAULT 1,
		initial_group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
		enabled INTEGER NOT NULL DEFAULT 1, subscription_purchase_disabled INTEGER NOT NULL DEFAULT 0)`)
	exec(t, fx.db, `INSERT INTO registration_domains_legacy SELECT domain,workspace_id,lock_personal,email_verification_required,initial_group_id,enabled,subscription_purchase_disabled FROM registration_domains`)
	exec(t, fx.db, `DROP TABLE registration_domains`)
	exec(t, fx.db, `ALTER TABLE registration_domains_legacy RENAME TO registration_domains`)
	exec(t, fx.db, `PRAGMA foreign_keys=ON`)
	for i := 0; i < 2; i++ {
		if err := Migrate(fx.db); err != nil {
			t.Fatal(err)
		}
	}
	rules, err := ListRegistrationDomains(ctx, fx.db)
	if err != nil || len(rules) != 1 || len(rules[0].Domains) != 2 || rules[0].MemberCount != 1 || !rules[0].SubscriptionPurchaseDisabled || !rules[0].EmailVerificationRequired {
		t.Fatalf("upgrade lost rule policies/matches/users: %+v, %v", rules, err)
	}
	access, err := GetDomainAccess(ctx, fx.db, user.ID)
	if err != nil || access == nil || !access.Locked || access.WorkspaceID != fx.workspaceID {
		t.Fatalf("upgrade changed member access: %+v, %v", access, err)
	}
	if err := SaveRegistrationDomain(ctx, fx.db, RegistrationDomain{Domain: "unassigned.example"}, true); err != nil {
		t.Fatal(err)
	}
	var workspace sql.NullString
	if err := fx.db.QueryRow(`SELECT workspace_id FROM registration_domains WHERE domain='unassigned.example'`).Scan(&workspace); err != nil || workspace.Valid {
		t.Fatalf("missing workspace must be SQL NULL: %+v, %v", workspace, err)
	}
	var enabled int
	if err := fx.db.QueryRow(`PRAGMA foreign_keys`).Scan(&enabled); err != nil || enabled != 1 {
		t.Fatalf("foreign keys were not restored: %d, %v", enabled, err)
	}
	if _, err := fx.db.Exec(`INSERT INTO registration_domains(domain,workspace_id) VALUES('bad.example','missing')`); err == nil {
		t.Fatal("workspace foreign key was lost during upgrade")
	}
}
