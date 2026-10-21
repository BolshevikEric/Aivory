package store

import (
	"encoding/json"
	"testing"
)

func TestWorkspaceMessageEditingMigrationAndPermissionRoundTrip(t *testing.T) {
	fx := newRBACFixture(t)
	disabled := false
	if _, err := UpdateWorkspacePolicy(t.Context(), fx.db, fx.workspaceID, "owner", WorkspacePolicyPatch{AllowDrawing: &disabled}); err != nil {
		t.Fatal(err)
	}
	exec(t, fx.db, `ALTER TABLE workspace_policies DROP COLUMN allow_message_editing`)
	exec(t, fx.db, `ALTER TABLE workspace_members DROP COLUMN can_edit_messages`)
	if err := Migrate(fx.db); err != nil {
		t.Fatal(err)
	}
	policy, err := GetWorkspacePolicy(t.Context(), fx.db, fx.workspaceID)
	if err != nil || !policy.AllowMessageEditing || policy.AllowDrawing {
		t.Fatalf("migrated policy=%+v err=%v", policy, err)
	}
	member, err := GetWorkspaceForMember(t.Context(), fx.db, fx.workspaceID, "member")
	if err != nil || !member.CanEditMessages {
		t.Fatalf("migrated member=%+v err=%v", member, err)
	}
	var patch WorkspaceMemberPermissions
	if err := json.Unmarshal([]byte(`{"can_edit_messages":false}`), &patch); err != nil {
		t.Fatal(err)
	}
	updated, err := UpdateWorkspaceMemberPermissions(t.Context(), fx.db, fx.workspaceID, "owner", "member", patch)
	if err != nil || updated.CanEditMessages || !updated.CanCreateProjects {
		t.Fatalf("updated member=%+v err=%v", updated, err)
	}
	if _, err := UpdateWorkspacePolicy(t.Context(), fx.db, fx.workspaceID, "owner", WorkspacePolicyPatch{AllowMessageEditing: &disabled}); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(fx.db); err != nil {
		t.Fatal(err)
	}
	policy, err = GetWorkspacePolicy(t.Context(), fx.db, fx.workspaceID)
	if err != nil || policy.AllowMessageEditing {
		t.Fatalf("repeated migration re-enabled policy=%+v err=%v", policy, err)
	}
	workspaces, err := ListWorkspacesForUser(t.Context(), fx.db, "member")
	if err != nil || len(workspaces) != 1 || workspaces[0].CanEditMessages {
		t.Fatalf("listed workspace=%+v err=%v", workspaces, err)
	}
	members, err := ListWorkspaceMembers(t.Context(), fx.db, fx.workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range members {
		if item.UserID == "member" && item.CanEditMessages {
			t.Fatal("member list lost the editing restriction")
		}
	}
	// Canonical ownership still grants the member-level ceiling without a
	// workspace_members row; the separate workspace policy remains restrictive.
	exec(t, fx.db, `DELETE FROM workspace_members WHERE workspace_id=? AND user_id='owner'`, fx.workspaceID)
	owner, err := GetWorkspaceForMember(t.Context(), fx.db, fx.workspaceID, "owner")
	if err != nil || !owner.CanEditMessages {
		t.Fatalf("canonical owner=%+v err=%v", owner, err)
	}
}
