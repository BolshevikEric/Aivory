package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"aivory/server/internal/store"
)

func TestWorkspaceMessageEditingIntersectsGroupPolicyAndMemberPermissions(t *testing.T) {
	owner, member, d, workspaceID, _ := openWorkspacePermissionHTTPTest(t)
	conv, err := store.CreateConversation(t.Context(), d.DB, store.Conversation{
		ID: "workspace-editing", UserID: owner.ID, WorkspaceID: workspaceID, IsPublic: true, Title: "Editing",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                         string
		group, workspace, memberEdit bool
		owner                        bool
		workspaceRole, siteRole      string
		want                         int
	}{
		{"all allow", true, true, true, false, "member", "user", http.StatusOK},
		{"group denies member", false, true, true, false, "member", "user", http.StatusForbidden},
		{"group denies owner", false, true, true, true, "admin", "user", http.StatusForbidden},
		{"group denies workspace admin", false, true, true, false, "admin", "user", http.StatusForbidden},
		{"workspace denies owner", true, false, true, true, "admin", "user", http.StatusForbidden},
		{"member denies", true, true, false, false, "member", "user", http.StatusForbidden},
		{"workspace admin bypasses member only", true, true, false, false, "admin", "user", http.StatusOK},
		{"site admin bypasses group", false, true, true, false, "member", "admin", http.StatusOK},
		{"site admin obeys workspace", true, false, true, false, "admin", "admin", http.StatusForbidden},
		{"site admin obeys member", true, true, false, false, "member", "admin", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor := *member
			if tc.owner {
				actor = *owner
			}
			actor.Role = tc.siteRole
			mustExec(t, d.DB, `UPDATE users SET role=? WHERE id=?`, tc.siteRole, actor.ID)
			mustExec(t, d.DB, `UPDATE workspace_members SET role=?,can_edit_messages=? WHERE workspace_id=? AND user_id=?`, tc.workspaceRole, tc.memberEdit, workspaceID, actor.ID)
			group := store.DefaultUserGroupPermissions()
			group.AllowMessageEditing = tc.group
			setIntersectionGroup(t, d, actor.ID, group)
			if _, err := store.UpdateWorkspacePolicy(t.Context(), d.DB, workspaceID, owner.ID, store.WorkspacePolicyPatch{AllowMessageEditing: &tc.workspace}); err != nil {
				t.Fatal(err)
			}
			for _, role := range []string{"user", "assistant"} {
				message, err := store.CreateMessage(t.Context(), d.DB, store.Message{
					ConversationID: conv.ID, Role: role, AuthorID: actor.ID,
					Blocks: json.RawMessage(`[{"kind":"text","text":"original"}]`),
				})
				if err != nil {
					t.Fatal(err)
				}
				rec := httptest.NewRecorder()
				editMessageHandler(d, rec, workspacePermissionRequest(t, http.MethodPatch, "/", &actor, map[string]string{"id": conv.ID, "msgId": message.ID}, map[string]string{"text": "edited"}))
				if rec.Code != tc.want {
					t.Fatalf("%s status=%d want=%d body=%s", role, rec.Code, tc.want, rec.Body.String())
				}
				stored, err := store.GetMessage(t.Context(), d.DB, message.ID)
				if err != nil {
					t.Fatal(err)
				}
				if tc.want == http.StatusForbidden && !bytes.Equal(stored.Blocks, message.Blocks) {
					t.Fatalf("denied %s edit changed message: %s", role, stored.Blocks)
				}
			}
			var raw string
			if err := d.DB.QueryRow(`SELECT permissions FROM user_groups WHERE id='intersection'`).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			storedGroup, err := store.NormalizeUserGroupPermissions(json.RawMessage(raw))
			if err != nil || storedGroup.AllowMessageEditing != tc.group {
				t.Fatalf("workspace policy changed group permission: %+v err=%v", storedGroup, err)
			}
		})
	}
}

func TestHTTPWorkspaceMessageEditingPolicyUpdatesRequireWorkspaceAdmin(t *testing.T) {
	owner, member, d, workspaceID, _ := openWorkspacePermissionHTTPTest(t)
	for _, actor := range []*store.User{member, owner} {
		rec := httptest.NewRecorder()
		updateWorkspacePolicyHandler(d, rec, workspacePermissionRequest(t, http.MethodPatch, "/", actor, map[string]string{"id": workspaceID}, map[string]bool{"allow_message_editing": false}))
		want := http.StatusOK
		if actor.ID == member.ID {
			want = http.StatusNotFound
		}
		if rec.Code != want {
			t.Fatalf("actor=%s status=%d body=%s", actor.ID, rec.Code, rec.Body.String())
		}
	}
	policy, err := store.GetWorkspacePolicy(t.Context(), d.DB, workspaceID)
	if err != nil || policy.AllowMessageEditing {
		t.Fatalf("policy switch was not persisted: %+v err=%v", policy, err)
	}
}
