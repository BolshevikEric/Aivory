package store

import (
	"context"
	"database/sql"
	"strings"
)

// AdminConversationShare lists share metadata without loading frozen transcripts.
// Retained shares remain visible even when their publisher loses sharing access.
type AdminConversationShare struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Title          string `json:"title"`
	UserID         string `json:"user_id"`
	UserEmail      string `json:"user_email"`
	UserName       string `json:"user_name"`
	CreatedAt      int64  `json:"created_at"`
}

type AdminConversationShareFilter struct {
	Search string
	UserID string
	UserQ  string
}

func adminConversationShareWhere(f AdminConversationShareFilter) (string, []any) {
	conditions := []string{}
	args := []any{}
	if search := strings.TrimSpace(f.Search); search != "" {
		like := "%" + strings.ToLower(search) + "%"
		conditions = append(conditions, `(LOWER(s.title) LIKE ? OR LOWER(s.id) LIKE ? OR LOWER(s.conversation_id) LIKE ?)`)
		args = append(args, like, like, like)
	}
	if userID := strings.TrimSpace(f.UserID); userID != "" {
		conditions = append(conditions, `s.user_id=?`)
		args = append(args, userID)
	}
	if user := strings.TrimSpace(f.UserQ); user != "" {
		like := "%" + strings.ToLower(user) + "%"
		conditions = append(conditions, `(s.user_id=? OR LOWER(COALESCE(u.email,'')) LIKE ? OR LOWER(COALESCE(u.name,'')) LIKE ?)`)
		args = append(args, user, like, like)
	}
	if len(conditions) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conditions, " AND "), args
}

func ListAdminConversationShares(ctx context.Context, db *sql.DB, f AdminConversationShareFilter, limit, offset int) ([]AdminConversationShare, error) {
	where, args := adminConversationShareWhere(f)
	args = append(args, limit, offset)
	rows, err := db.QueryContext(ctx, `
		SELECT s.id, s.conversation_id, s.title, s.user_id,
		       COALESCE(u.email,''), COALESCE(u.name,''), s.created_at
		  FROM conversation_shares s
		  LEFT JOIN users u ON u.id=s.user_id`+where+`
		 ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AdminConversationShare{}
	for rows.Next() {
		var item AdminConversationShare
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.Title, &item.UserID, &item.UserEmail, &item.UserName, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func CountAdminConversationShares(ctx context.Context, db *sql.DB, f AdminConversationShareFilter) (int, error) {
	where, args := adminConversationShareWhere(f)
	var total int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversation_shares s
		LEFT JOIN users u ON u.id=s.user_id`+where, args...).Scan(&total)
	return total, err
}
