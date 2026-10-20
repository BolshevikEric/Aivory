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

const generativeUIDescription = "Proactively use the simplest inline UI when it improves readability, comparison, calculation, understanding, or interaction; keep code and HTML requests as ordinary copyable code."

// Retain only fingerprints for upgrading untouched defaults in existing databases.
// The current prompt is the sole embedded instruction document.
var retiredGenerativeUIInstructionHashes = []string{
	"a348f9ba689b8804a765d68557e6012ec6375df390c957bae98c72d67d3168c3",
	"852cebb28a837777c295af68cfbcf4f9bd78c5e7822ae1c1486f399f45f8fbc1",
	"f3d137ded625a341d93ac98d75574f6c31aef17b63423aef5bc7aedf068012f1",
	"7b67056ee68374b265eb42aab43d0d2b968f72da03f603d72a3af41bc91e4238",
	"34fcf0cdef3e6e8d525eb7c2e59259b885c53728f4c083c424da37dd399f90b9",
	"74962b66125799b2b8c52f42826ec96202dd51aaa70a332a14e02ca964d0401b",
	"c22a875d277f8f20e7a7882c6108aa31813b86cc8a06f20f1bda232ff241a429",
	"8c7e30809eb822137abdcd3b80307b275f6d5c2e3011c3c20f0e5d0323fb625e",
	"0306f32751b80cd28d465705d11b4343f4fc4caf940cb1bf8455d257ceeda05e",
	"5b315c93055a958bdec680b1098ca0b8b43ee32bc5c03298e7ec54a9ad2b8a5b",
	"85d503b348c5f3a19bb372f4a0de1db0037171af1e511e91e516ddb10049a00f",
	"9745bb2871794a09e980c0872e1f80afb0bdbd4d9ac9ad3709595d15f1b1da26",
	"2a738c843635627d92472662494d69bcaeedbc8f42a3e982bdbd9f10c1c9a9b7",
	"127ca0b430f1a786f2115c3a30978c781191aa8b268a5ed6c772ff2eab970bad",
	"85244ec4dbebcf3badd65881f6c07bcda89672830127d16cea6705e3b2565930",
	"2bb004ec29fa4fa750ddce1dc94167110568739ba977a1932642e5403c2fa8c1",
}

var retiredGenerativeUIDescriptionHashes = []string{
	"63bc4d66a3d87c566f33f4b8dea47161fa29a7acc4ebfe27299e370267ee809c",
	"f7762a30ebcb63402798ce6f4f5364b4f6ac52132a9e04a3364019d80c6aef03",
	"f45798cf5a1d5bb7e6dc430cc3d0d9256499c6c3a8923c21b61eb28a391b53e5",
	"f814aa1c192f81ad4900a22d9bb5593c247a9c36ada1d0b29df7ecb7c842991c",
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
