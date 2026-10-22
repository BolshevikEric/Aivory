package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrModelGroupAccess = errors.New("model is not available for your user group")
var ErrInvalidModelGroupAccess = errors.New("invalid model user-group access policy")

func NormalizeModelDeniedGroupIDs(ids []string) ([]string, error) {
	if len(ids) > 1000 {
		return nil, ErrInvalidModelGroupAccess
	}
	result := []string{}
	seen := map[string]bool{}
	for _, value := range ids {
		id := strings.TrimSpace(value)
		if id == "" || len(id) > 200 {
			return nil, ErrInvalidModelGroupAccess
		}
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result, nil
}

func (m Model) AllowsUserGroup(groupID string) bool {
	for _, denied := range m.DeniedGroupIDs {
		if denied == groupID {
			return false
		}
	}
	return true
}

// Resolve membership at admission time, including temporary-group expiry.
// System administrators retain the same bypass as other user-group policies.
func CheckModelGroupAccess(ctx context.Context, db *sql.DB, userID string, model *Model) error {
	if model == nil || len(model.DeniedGroupIDs) == 0 {
		return nil
	}
	user, err := FindUserByID(ctx, db, userID)
	if err != nil {
		return err
	}
	if user.Role != "admin" && !model.AllowsUserGroup(user.GroupID) {
		return ErrModelGroupAccess
	}
	return nil
}

func FilterModelsByUserGroup(ctx context.Context, db *sql.DB, userID string, models []Model) ([]Model, error) {
	var user *User
	filtered := make([]Model, 0, len(models))
	for _, model := range models {
		if len(model.DeniedGroupIDs) > 0 {
			if user == nil {
				var err error
				user, err = FindUserByID(ctx, db, userID)
				if err != nil {
					return nil, err
				}
			}
			if user.Role != "admin" && !model.AllowsUserGroup(user.GroupID) {
				continue
			}
		}
		filtered = append(filtered, model)
	}
	return filtered, nil
}
