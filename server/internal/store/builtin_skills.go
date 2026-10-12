package store

import (
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"fmt"
	"slices"
	"time"
)

//go:embed skills/generative-ui.md
var generativeUIInstructions string

const GenerativeUISkillID = "sk_generative_ui"
const CatalogSkillCommandPrefix = "catalog:"

const generativeUIDescription = "Proactively use inline UI whenever it improves readability, understanding, or interaction. Infer suitable components from the user's intent and conversation without requiring an explicit UI request."

// Retain only fingerprints for upgrading untouched defaults in existing databases.
// The current prompt is the sole embedded instruction document.
var retiredGenerativeUIInstructionHashes = []string{
	"5b315c93055a958bdec680b1098ca0b8b43ee32bc5c03298e7ec54a9ad2b8a5b",
	"85d503b348c5f3a19bb372f4a0de1db0037171af1e511e91e516ddb10049a00f",
	"9745bb2871794a09e980c0872e1f80afb0bdbd4d9ac9ad3709595d15f1b1da26",
	"2a738c843635627d92472662494d69bcaeedbc8f42a3e982bdbd9f10c1c9a9b7",
	"127ca0b430f1a786f2115c3a30978c781191aa8b268a5ed6c772ff2eab970bad",
	"85244ec4dbebcf3badd65881f6c07bcda89672830127d16cea6705e3b2565930",
}

var retiredGenerativeUIDescriptionHashes = []string{
	"63bc4d66a3d87c566f33f4b8dea47161fa29a7acc4ebfe27299e370267ee809c",
	"f7762a30ebcb63402798ce6f4f5364b4f6ac52132a9e04a3364019d80c6aef03",
	"f45798cf5a1d5bb7e6dc430cc3d0d9256499c6c3a8923c21b61eb28a391b53e5",
}

func builtinSkillFingerprint(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}

// Refresh only untouched shipped fields; preserve administrator customizations.
func seedBuiltinSkills(db *sql.DB) error {
	_, err := db.Exec(`INSERT INTO skills(id,name,description,display_description,icon,instructions,assets,enabled,sort_order,updated_at)
		VALUES(?,?,?,?,?,?,'[]',1,0,?) ON CONFLICT DO NOTHING`, GenerativeUISkillID, "generative-ui",
		generativeUIDescription,
		"Visual answers with charts, tables and interactive interfaces.", "PanelsTopLeft", generativeUIInstructions, time.Now().Unix())
	if err != nil {
		return err
	}
	return refreshBuiltinSkillDefaults(db, retiredGenerativeUIDescriptionHashes, retiredGenerativeUIInstructionHashes)
}

func refreshBuiltinSkillDefaults(db *sql.DB, previousDescriptions, previousInstructions []string) error {
	var description, instructions string
	err := db.QueryRow(`SELECT description,instructions FROM skills WHERE id=?`, GenerativeUISkillID).Scan(&description, &instructions)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	nextDescription, nextInstructions := description, instructions
	if slices.Contains(previousDescriptions, builtinSkillFingerprint(description)) {
		nextDescription = generativeUIDescription
	}
	if slices.Contains(previousInstructions, builtinSkillFingerprint(instructions)) {
		nextInstructions = generativeUIInstructions
	}
	if nextDescription == description && nextInstructions == instructions {
		return nil
	}
	// Compare each field again at write time to preserve concurrent admin edits.
	_, err = db.Exec(`UPDATE skills SET
		description=CASE WHEN description=? THEN ? ELSE description END,
		instructions=CASE WHEN instructions=? THEN ? ELSE instructions END,
		updated_at=? WHERE id=? AND ((description=? AND description<>?) OR (instructions=? AND instructions<>?))`,
		description, nextDescription, instructions, nextInstructions, time.Now().Unix(), GenerativeUISkillID,
		description, nextDescription, instructions, nextInstructions)
	return err
}
