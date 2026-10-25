import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	CANONICAL_NAMESPACE_UUID,
	canonicalIdFor,
	convertOpenCodeSession,
	findSessionFileByCanonicalId,
	formatImportStatus,
	formatSessionList,
	listOpenCodeSessions,
	loadImportRegistry,
	loadOpenCodeSession,
	planBulkImport,
	recordImportedSession,
	saveImportRegistry,
	uuidv5,
	type ConvertedImport,
} from "./core";

let tempRoot: string;
let dbPath: string;
let registryPath: string;

function sqlite(sql: string): void {
	const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
}

function json(value: unknown): string {
	return JSON.stringify(value).replaceAll("'", "''");
}

function insertMessage(sessionId: string, id: string, role: "user" | "assistant", time: number, text: string): void {
	const data = role === "assistant"
		? { role, providerID: "anthropic", modelID: "claude-sonnet-4-6", time: { created: time }, finish: "stop" }
		: { role, time: { created: time } };
	sqlite(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('${id}', '${sessionId}', ${time}, ${time}, '${json(data)}')`);
	sqlite(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_${id}', '${id}', '${sessionId}', ${time}, ${time}, '${json({ type: "text", text })}')`);
}
function insertV2Message(sessionId: string, id: string, type: string, seq: number, time: number, data: unknown): void {
	sqlite(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('${id}', '${sessionId}', '${type}', ${seq}, ${time}, ${time}, '${json(data)}')`);
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "opencode-import-core-"));
	mkdirSync(tempRoot, { recursive: true });
	dbPath = join(tempRoot, "opencode.db");
	registryPath = join(tempRoot, "registry.json");
	sqlite(`
		CREATE TABLE session (
			id text PRIMARY KEY,
			project_id text NOT NULL,
			parent_id text,
			slug text NOT NULL,
			directory text NOT NULL,
			title text NOT NULL,
			version text NOT NULL,
			time_created integer NOT NULL,
			time_updated integer NOT NULL,
			time_archived integer,
			agent text,
			model text
		);
		CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
		CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
		CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, directory text NOT NULL, title text, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer, agent text, model text);
		CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
	`);
	sqlite(`
		INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, agent, model) VALUES
			('ses_alpha', 'proj', 'alpha', '/repo/a', 'Alpha Session', '0.13.0', 1000, 5000, 'orchestrator', 'claude-sonnet-4-6'),
			('ses_beta', 'proj', 'beta', '/repo/b', 'Beta Session', '0.13.0', 2000, 6000, 'orchestrator', 'claude-sonnet-4-6'),
			('ses_archived', 'proj', 'archived', '/repo/a', 'Archived Session', '0.13.0', 3000, 7000, 'orchestrator', 'claude-sonnet-4-6');
		UPDATE session SET time_archived = 8000 WHERE id = 'ses_archived';
	`);
	insertMessage("ses_alpha", "msg_alpha_user", "user", 1100, "alpha question");
	insertMessage("ses_alpha", "msg_alpha_assistant", "assistant", 1200, "alpha answer");
	insertMessage("ses_beta", "msg_beta_user", "user", 2100, "beta question");
	insertMessage("ses_beta", "msg_beta_assistant", "assistant", 2200, "beta answer");
	sqlite(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, agent, model) VALUES ('ses_gamma', 'proj', '/repo/v2', 'Gamma Session', '2.1.3', 2500, 6500, 'build', '{"id":"m1","providerID":"opencode"}')`);
	insertV2Message("ses_gamma", "msg_gamma_user", "user", 1, 2600, { time: { created: 2600 }, text: "gamma question", files: [], agents: [] });
	insertV2Message("ses_gamma", "msg_gamma_assistant", "assistant", 2, 2700, { time: { created: 2700 }, agent: "build", model: { id: "m1", providerID: "opencode" }, finish: "stop", tokens: { input: 10, output: 5 }, cost: 0, content: [{ type: "text", text: "gamma answer" }, { type: "tool", id: "call1", name: "read", state: { status: "completed", input: { path: "/repo/v2" }, content: [{ type: "text", text: "tool output here" }] } }] });
	insertV2Message("ses_gamma", "msg_gamma_compaction", "compaction", 3, 2800, { time: { created: 2800 }, summary: "gamma summary" });
	insertV2Message("ses_gamma", "msg_gamma_system", "system", 4, 2900, { time: { created: 2900 }, text: "notice" });
});

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("production import planning", () => {
	test("plans dry-run bulk imports with cwd and updated-since filters without loading archived sessions", () => {
		const registry = loadImportRegistry(registryPath);
		const plan = planBulkImport(dbPath, registry, { cwd: "/repo/a", updatedSince: 4000, dryRun: true, limit: 50 });
		expect(plan.sessions.map((session) => session.id)).toEqual(["ses_alpha"]);
		expect(plan.toImport.map((session) => session.id)).toEqual(["ses_alpha"]);
		expect(plan.skippedAlreadyImported).toEqual([]);
		expect(plan.dryRun).toBe(true);
	});

	test("records imported sessions and makes later bulk plans idempotent unless forced", () => {
		let registry = loadImportRegistry(registryPath);
		const converted: ConvertedImport = convertOpenCodeSession(loadOpenCodeSession(dbPath, "ses_alpha"), { maxToolChars: 0 });
		recordImportedSession(registry, {
			sourceSession: loadOpenCodeSession(dbPath, "ses_alpha").session,
			converted,
			runtime: "omp",
			targetSessionFile: "/tmp/target-alpha.jsonl",
			sourceDbPath: dbPath,
		});
		saveImportRegistry(registryPath, registry);

		registry = loadImportRegistry(registryPath);
		const normalPlan = planBulkImport(dbPath, registry, { cwd: "/repo/a", limit: 50 });
		expect(normalPlan.toImport).toEqual([]);
		expect(normalPlan.skippedAlreadyImported.map((session) => session.id)).toEqual(["ses_alpha"]);

		const forcedPlan = planBulkImport(dbPath, registry, { cwd: "/repo/a", force: true, limit: 50 });
		expect(forcedPlan.toImport.map((session) => session.id)).toEqual(["ses_alpha"]);
	});

	test("formats status with imported target path and pending sessions", () => {
		const registry = loadImportRegistry(registryPath);
		recordImportedSession(registry, {
			sourceSession: loadOpenCodeSession(dbPath, "ses_alpha").session,
			converted: convertOpenCodeSession(loadOpenCodeSession(dbPath, "ses_alpha"), { maxToolChars: 0 }),
			runtime: "pi",
			targetSessionFile: "/tmp/pi-alpha.jsonl",
			sourceDbPath: dbPath,
		});
		const status = formatImportStatus(planBulkImport(dbPath, registry, { limit: 50 }), registry);
		expect(status).toContain("Imported: 1");
		expect(status).toContain("Pending: 2");
		expect(status).toContain("ses_alpha");
		expect(status).toContain("/tmp/pi-alpha.jsonl");
	});
});

describe("canonical session UUIDs", () => {
	test("uuidv5 matches the RFC4122 DNS test vector for cross-implementation parity", () => {
		const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
		expect(uuidv5("www.example.org", dns)).toBe("74738ff5-5367-5958-9aee-98fffdcd1876");
	});

	test("canonicalIdFor returns a stable UUIDv5 for OpenCode lineage", () => {
		const a = canonicalIdFor("opencode", "ses_alpha");
		const b = canonicalIdFor("opencode", "ses_alpha");
		const c = canonicalIdFor("opencode", "ses_beta");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a)).toBe(true);
	});

	test("canonicalIdFor returns native UUID unchanged for non-opencode runtimes", () => {
		expect(canonicalIdFor("pi", "019e31c8-3708-712e-bec1-9b175acc32f9")).toBe("019e31c8-3708-712e-bec1-9b175acc32f9");
		expect(canonicalIdFor("omp", "019e3581-e6c6-7000-91d7-086442976f90")).toBe("019e3581-e6c6-7000-91d7-086442976f90");
	});

	test("convertOpenCodeSession assigns canonical id and lineage metadata", () => {
		const converted = convertOpenCodeSession(loadOpenCodeSession(dbPath, "ses_alpha"), { maxToolChars: 0 });
		expect(converted.lineageRuntime).toBe("opencode");
		expect(converted.lineageId).toBe("ses_alpha");
		expect(converted.canonicalId).toBe(canonicalIdFor("opencode", "ses_alpha"));
	});

	test("findSessionFileByCanonicalId locates a previously-written canonical file", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const canonical = canonicalIdFor("opencode", "ses_canonical");
		const sessionDir = join(tempRoot, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const filePath = join(sessionDir, `2026-05-17T00-00-00-000Z_${canonical}.jsonl`);
		fs.writeFileSync(filePath, `${JSON.stringify({ type: "session", version: 3, id: canonical, timestamp: "2026-05-17T00:00:00.000Z", cwd: "/repo/a" })}\n`);
		expect(findSessionFileByCanonicalId(sessionDir, canonical)).toBe(filePath);
		expect(findSessionFileByCanonicalId(sessionDir, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
	});

	test("CANONICAL_NAMESPACE_UUID is a stable identifier shared across packages", () => {
		expect(CANONICAL_NAMESPACE_UUID).toBe("6e7b9c2a-3f4d-5e1f-a8b7-1c2d3e4f5a6b");
	});
});

describe("delegated session filtering", () => {
	test("listOpenCodeSessions excludes delegated subagent sessions by default", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
		// Add a delegated session to fixture DB
		const sql = `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, agent, model) VALUES ('ses_subagent', 'proj', 'ses_alpha', 'sub', '/repo/a', 'Audit (@oracle subagent)', '0.13.0', 4000, 9000, 'oracle', 'claude-sonnet-4-6')`;
		const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);

		// Default: should NOT include delegated
		const defaultPlan = require("./core").listOpenCodeSessions(dbPath, { limit: 50 });
		expect(defaultPlan.map((s: { id: string }) => s.id).sort()).toEqual(["ses_alpha", "ses_beta", "ses_gamma"]);

		// Explicit mainOnly:false should include delegated
		const withDelegated = require("./core").listOpenCodeSessions(dbPath, { limit: 50, mainOnly: false });
		expect(withDelegated.map((s: { id: string }) => s.id).sort()).toEqual(["ses_alpha", "ses_beta", "ses_gamma", "ses_subagent"]);
	});
});

describe("opencode 2.X store", () => {
	test("listOpenCodeSessions unions v1 and v2 stores with a store marker", () => {
		const sessions = listOpenCodeSessions(dbPath, { limit: 50 });
		const byId = new Map(sessions.map((s) => [s.id, s]));
		expect(byId.get("ses_alpha")?.store).toBe("v1");
		expect(byId.get("ses_gamma")?.store).toBe("v2");
		expect(byId.get("ses_gamma")?.title).toBe("Gamma Session");
	});

	test("listOpenCodeSessions search matches v2 titles and directories", () => {
		expect(listOpenCodeSessions(dbPath, { search: "gamma" }).map((s) => s.id)).toEqual(["ses_gamma"]);
		expect(listOpenCodeSessions(dbPath, { cwd: "/repo/v2" }).map((s) => s.id)).toEqual(["ses_gamma"]);
	});

	test("convertOpenCodeSession maps v2 user, assistant, tool and compaction rows", () => {
		const converted = convertOpenCodeSession(loadOpenCodeSession(dbPath, "ses_gamma"), { maxToolChars: 100 });
		expect(converted.messages.map((m) => m.role)).toEqual(["user", "assistant", "compaction"]);
		expect(converted.model).toEqual({ providerID: "opencode", modelID: "m1" });
		const assistant = converted.messages[1];
		expect(assistant.role).toBe("assistant");
		if (assistant.role !== "assistant") throw new Error("narrowing failed");
		const text = assistant.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		expect(text).toContain("gamma answer");
		expect(text).toContain("[OpenCode tool call: read (completed) id=call1]");
		expect(text).toContain("tool output here");
		expect(assistant.content.every((b) => b.type === "text")).toBe(true);
		const compaction = converted.messages[2];
		expect(compaction.role).toBe("compaction");
		if (compaction.role !== "compaction") throw new Error("narrowing failed");
		expect(compaction.summary).toBe("gamma summary");
	});

	test("loadOpenCodeSession throws for unknown ids in both stores", () => {
		expect(() => loadOpenCodeSession(dbPath, "ses_missing")).toThrow("OpenCode session not found: ses_missing");
	});

	test("formatSessionList shows store marker and short date", () => {
		const line = formatSessionList(listOpenCodeSessions(dbPath, { search: "gamma" }));
		expect(line).toContain("v2");
		expect(line).toContain("Gamma Session");
	});
});
