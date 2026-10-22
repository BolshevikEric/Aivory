package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
)

func modelGroupAccessFixture(t *testing.T) imageCapabilityFixture {
	t.Helper()
	fx := seedImageCapabilityFixture(t)
	raw, _ := json.Marshal(store.DefaultUserGroupPermissions())
	mustExec(t, fx.deps.DB, `INSERT INTO user_groups(id,name,permissions) VALUES('model-group','Model group',?)`, string(raw))
	mustExec(t, fx.deps.DB, `UPDATE users SET role='user',group_id='model-group' WHERE id='u1'`)
	fx.user.Role, fx.user.GroupID = "user", "model-group"
	mustExec(t, fx.deps.DB, `UPDATE models SET denied_group_ids='["model-group"]' WHERE id IN ('m_plain','m_image','m_fast')`)
	return fx
}

func TestModelGroupAccessCatalogDefaultAndFast(t *testing.T) {
	fx := modelGroupAccessFixture(t)
	mustExec(t, fx.deps.DB, `UPDATE models SET vision=1 WHERE id='m_plain'`)
	for _, key := range []string{"verify_model_id", "vision_model_id"} {
		if err := store.SetSetting(fx.deps.DB, key, "m_plain"); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		target    string
		handler   func(Deps, http.ResponseWriter, *http.Request)
		ids       []string
		defaultID string
	}{
		{"/api/models", listModelsHandler, []string{"m_vision"}, "m_vision"},
		{"/api/image-models", listImageModelsHandler, []string{}, ""},
	} {
		rec := httptest.NewRecorder()
		tc.handler(fx.deps, rec, userGroupPermissionRequest(http.MethodGet, tc.target, fx.user, nil, ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("catalog status=%d body=%s", rec.Code, rec.Body.String())
		}
		var payload struct {
			Models          []store.Model `json:"models"`
			DefaultID       string        `json:"default_id"`
			FastAvailable   bool          `json:"fast_available"`
			VerifyAvailable bool          `json:"verify_available"`
			VisionAvailable bool          `json:"vision_available"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, model := range payload.Models {
			ids = append(ids, model.ID)
		}
		if !reflect.DeepEqual(ids, tc.ids) || payload.DefaultID != tc.defaultID || payload.FastAvailable {
			t.Fatalf("catalog=%s", rec.Body.String())
		}
		if payload.VerifyAvailable || payload.VisionAvailable {
			t.Fatalf("denied auxiliary model exposed capabilities: %s", rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "denied_group_ids") {
			t.Fatal("public catalog exposed group policy")
		}
	}
	// Both a stale account default and a denied global default fall back to an
	// allowed model. Automatic fast mode must not resurrect a denied fast model.
	fx.user.Settings = json.RawMessage(`{"default_model_id":"m_plain"}`)
	rec := httptest.NewRecorder()
	createConversationHandler(fx.deps, rec, userGroupPermissionRequest(http.MethodPost, "/api/conversations", fx.user, nil, `{}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("automatic create=%d %s", rec.Code, rec.Body.String())
	}
	var conv store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &conv); err != nil {
		t.Fatal(err)
	}
	if conv.ModelID != "m_vision" || conv.Fast {
		t.Fatalf("automatic model=%+v", conv)
	}
	for _, body := range []string{`{"model_id":"m_plain"}`, `{"model_id":"m_vision","fast":true}`} {
		rec := httptest.NewRecorder()
		createConversationHandler(fx.deps, rec, userGroupPermissionRequest(http.MethodPost, "/api/conversations", fx.user, nil, body))
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), store.ErrModelGroupAccess.Error()) {
			t.Fatalf("explicit create=%d %s", rec.Code, rec.Body.String())
		}
	}
}

func TestModelGroupAccessRevokesExistingTurnsAndWorkspaceAdmin(t *testing.T) {
	fx := modelGroupAccessFixture(t)
	provider := &privateAPIProvider{}
	registry := llm.NewRegistry(nil)
	registry.Register(provider)
	fx.deps.Orchestrator = llm.NewOrchestrator(fx.deps.DB, registry, nil, nil, nil, nil, nil, nil, nil)
	for _, tc := range []struct {
		name, body string
		handler    func(Deps, http.ResponseWriter, *http.Request)
	}{
		{"send", `{"text":"hello"}`, postMessageHandler},
		{"regenerate", `{}`, regenerateHandler},
		{"change selection", `{"model_id":"m_plain"}`, updateConversationHandler},
		{"private", `{"model_id":"m_plain","messages":[{"role":"user","text":"hello"}]}`, privateChatHandler},
		{"tools", ``, listSelectableToolsHandler},
	} {
		rec := httptest.NewRecorder()
		tc.handler(fx.deps, rec, userGroupPermissionRequest(http.MethodPost, "/api/test?model_id=m_plain", fx.user, map[string]string{"id": fx.conv.ID}, tc.body))
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), store.ErrModelGroupAccess.Error()) {
			t.Fatalf("%s=%d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	workspace, err := store.CreateWorkspace(t.Context(), fx.deps.DB, fx.user.ID, "Model permissions")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	createConversationHandler(fx.deps, rec, userGroupPermissionRequest(http.MethodPost, "/api/conversations", fx.user, nil, `{"model_id":"m_plain","workspace_id":"`+workspace.ID+`"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("workspace admin bypassed group=%d %s", rec.Code, rec.Body.String())
	}
	if provider.calls != 0 {
		t.Fatalf("denied turns reached provider %d times", provider.calls)
	}
	var count int
	if err := fx.deps.DB.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("messages=%d err=%v", count, err)
	}
}

func TestAdminModelGroupAccessPatchAndBackupValidation(t *testing.T) {
	fx := modelGroupAccessFixture(t)
	for _, tc := range []struct {
		body   string
		status int
		ids    []string
	}{
		{`{"label":"Renamed"}`, http.StatusOK, []string{"model-group"}},
		{`{"denied_group_ids":[" model-group ","model-group","other-group"]}`, http.StatusOK, []string{"model-group", "other-group"}},
		{`{"denied_group_ids":[""]}`, http.StatusBadRequest, nil},
		{`{"denied_group_ids":{}}`, http.StatusBadRequest, nil},
		{`{"denied_group_ids":[]}`, http.StatusOK, []string{}},
	} {
		rec := httptest.NewRecorder()
		updateModelAdmin(fx.deps, rec, userGroupPermissionRequest(http.MethodPatch, "/api/admin/models/m_plain", fx.user, map[string]string{"id": "m_plain"}, tc.body))
		if rec.Code != tc.status {
			t.Fatalf("patch %s=%d %s", tc.body, rec.Code, rec.Body.String())
		}
		if tc.status == http.StatusOK {
			model, err := store.GetModel(t.Context(), fx.deps.DB, "m_plain")
			if err != nil || !reflect.DeepEqual(model.DeniedGroupIDs, tc.ids) {
				t.Fatalf("policy=%v err=%v", model, err)
			}
		}
	}
	for _, raw := range []string{`[" model-group ","model-group"]`, `[]`, `null`, `{}`, `[""]`, `malformed`} {
		row, _ := json.Marshal(map[string]string{"denied_group_ids": raw})
		reader, err := normalizeModelOfficialToolsArchiveRows(strings.NewReader(string(row)))
		valid := raw == `[]` || raw == `null` || strings.HasPrefix(raw, `[" model-group `)
		if valid != (err == nil) {
			t.Fatalf("backup policy %s error=%v", raw, err)
		}
		if valid {
			body, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			var normalized map[string]string
			if err := json.Unmarshal(body, &normalized); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(normalized["denied_group_ids"], " model-group ") || normalized["denied_group_ids"] == "null" {
				t.Fatalf("unnormalized backup=%s", body)
			}
		}
	}
}

func TestModelGroupAccessUpdatesRefreshConnectedCatalogs(t *testing.T) {
	fx := modelGroupAccessFixture(t)
	fx.deps.Cache = eventsTestCache
	conn := eventsHub.registerForGroup("model-access-connected", "model-group")
	t.Cleanup(func() { eventsHub.unregister("model-access-connected", conn) })
	for _, tc := range []struct {
		body    string
		changed bool
	}{
		{`{"label":"Renamed"}`, false},
		{`{"denied_group_ids":[]}`, true},
		{`{"denied_group_ids":[]}`, false},
		{`{"denied_group_ids":["model-group"]}`, true},
	} {
		rec := httptest.NewRecorder()
		updateModelAdmin(fx.deps, rec, userGroupPermissionRequest(http.MethodPatch, "/api/admin/models/m_plain", fx.user, map[string]string{"id": "m_plain"}, tc.body))
		if rec.Code != http.StatusOK {
			t.Fatalf("patch=%d %s", rec.Code, rec.Body.String())
		}
		if tc.changed {
			assertAccessEventType(t, conn, "account.permissions_updated")
		} else {
			assertNoPermissionEvent(t, conn)
		}
	}
}
