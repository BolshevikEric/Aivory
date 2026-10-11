package llm

import (
	"encoding/json"
	"strings"
	"testing"

	"aivory/server/internal/store"
)

func TestDisabledModelSkillsPersistRegenerateFallbackAndManualOverride(t *testing.T) {
	o, provider, model, conv, _, db := setupToolRouteTest(t)
	skill := bindPresentationTestSkill(t, db, model.ID)
	result, err := o.Run(t.Context(), RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "Explain this", ToolMode: ToolModeEnabled, DisabledModelSkillIDs: []string{skill.ID}}, func(SseEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	request := provider.mainRequests[0]
	if strings.Contains(request.SystemPrompt, "PRESENTATION_BODY") || len(request.DisabledModelSkillIDs) != 1 {
		t.Fatal("disabled skill reached the prompt or fallback lost exclusion")
	}
	saved, err := store.GetMessage(t.Context(), db, result.UserMessage.ID)
	if err != nil || string(saved.DisabledModelSkillIDs) != `["`+skill.ID+`"]` {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	wire, _ := json.Marshal(saved)
	if strings.Contains(string(wire), "disabled_model_skill_ids") {
		t.Fatal("internal skill configuration leaked through public message JSON")
	}
	_, err = o.Run(t.Context(), RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "Explain this", ToolMode: ToolModeEnabled, ParentID: result.UserMessage.ID, ReuseExistingUserMessage: true}, func(SseEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(provider.mainRequests[1].SystemPrompt, "PRESENTATION_BODY") {
		t.Fatal("regeneration restored a disabled default")
	}
	fallback, _, _, err := o.buildFallbackRequest(t.Context(), request, model.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fallback.SystemPrompt, "PRESENTATION_BODY") {
		t.Fatal("fallback restored a disabled default")
	}
	_, err = o.Run(t.Context(), RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "Use visuals", ToolMode: ToolModeEnabled, SelectedUserSkillIDs: []string{store.CatalogSkillCommandPrefix + skill.ID}, DisabledModelSkillIDs: []string{skill.ID}}, func(SseEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	manual := provider.mainRequests[2]
	if strings.Contains(manual.SystemPrompt, "PRESENTATION_BODY") || !strings.Contains(renderBlocksAsText(manual.History[len(manual.History)-1].Blocks), "PRESENTATION_BODY") {
		t.Fatal("manual override was not injected exactly at user authority")
	}
	_, err = o.Run(t.Context(), RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "Next turn", ToolMode: ToolModeEnabled, DisabledModelSkillIDs: []string{skill.ID}}, func(SseEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	next := provider.mainRequests[3]
	if strings.Contains(next.SystemPrompt, "PRESENTATION_BODY") || strings.Contains(renderBlocksAsText(next.History[len(next.History)-1].Blocks), "PRESENTATION_BODY") {
		t.Fatal("manual override silently reactivated the default on the next turn")
	}
	restored, err := o.Run(t.Context(), RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "Restore defaults", ToolMode: ToolModeEnabled}, func(SseEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	restoredRequest := provider.mainRequests[4]
	if strings.Count(restoredRequest.SystemPrompt, "PRESENTATION_BODY") != 1 || len(restoredRequest.DisabledModelSkillIDs) != 0 || len(restoredRequest.SelectedUserSkillIDs) != 0 || strings.Contains(renderBlocksAsText(restoredRequest.History[len(restoredRequest.History)-1].Blocks), "PRESENTATION_BODY") {
		t.Fatal("restoring a cancelled default did not restore exactly one system injection")
	}
	savedRestored, err := store.GetMessage(t.Context(), db, restored.UserMessage.ID)
	if err != nil || string(savedRestored.DisabledModelSkillIDs) != `[]` {
		t.Fatalf("restored snapshot=%+v err=%v", savedRestored, err)
	}
	restoredFallback, _, _, err := o.buildFallbackRequest(t.Context(), restoredRequest, model.ID)
	if err != nil || strings.Count(restoredFallback.SystemPrompt, "PRESENTATION_BODY") != 1 {
		t.Fatalf("restored default lost during fallback: %v", err)
	}
}

func TestDisabledSkillHistoryCannotReplayInstructions(t *testing.T) {
	_, _, model, _, _, db := setupToolRouteTest(t)
	skill := bindPresentationTestSkill(t, db, model.ID)
	blocks, _ := json.Marshal([]UnifiedBlock{{Kind: "tool_call", ToolName: "use_skill", ToolID: "sk-call", Input: json.RawMessage(`{"name":"generative-ui"}`)}, {Kind: "tool_output", ToolName: "use_skill", ToolID: "sk-call", Text: "SECRET_SKILL_INSTRUCTIONS"}, {Kind: "text", Text: "Visible answer"}})
	history := []store.Message{{Role: "assistant", Blocks: blocks, Raw: json.RawMessage(`{"result":"SECRET_SKILL_INSTRUCTIONS"}`)}}
	filtered, err := stripDisabledSkillHistory(t.Context(), db, history, []string{skill.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered[0].Raw) != 0 || strings.Contains(string(filtered[0].Blocks), "SECRET") || !strings.Contains(string(filtered[0].Blocks), "Visible answer") {
		t.Fatalf("filtered=%+v", filtered)
	}
	if !strings.Contains(string(history[0].Blocks), "SECRET") || len(history[0].Raw) == 0 {
		t.Fatal("saved history mutated")
	}
}

func TestDisabledModelSkillSelectionBounds(t *testing.T) {
	ids, err := NormalizeDisabledModelSkillIDs([]string{" a ", "a", "", "b"})
	if err != nil || strings.Join(ids, ",") != "a,b" {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	if _, err := NormalizeDisabledModelSkillIDs(make([]string, 257)); err == nil {
		t.Fatal("unbounded exclusion list accepted")
	}
}
