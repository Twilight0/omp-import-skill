import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ConvertedContent = TextContent | ImageContent | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface OpenCodeSessionRow {
	id: string;
	project_id: string;
	parent_id: string | null;
	directory: string;
	title: string;
	version: string;
	time_created: number;
	time_updated: number;
	agent: string | null;
	model: string | null;
	/** Which OpenCode store the row came from: v1 (`session`) or 2.X (`session_v2`). */
	store: "v1" | "v2";
}

export interface OpenCodeMessageRow {
	id: string;
	session_id: string;
	time_created: number;
	time_updated: number;
	data: string;
}

export interface OpenCodePartRow {
	id: string;
	message_id: string;
	session_id: string;
	time_created: number;
	time_updated: number;
	data: string;
}

export interface OpenCodeSessionMessageRow {
	id: string;
	session_id: string;
	type: string;
	seq: number;
	time_created: number;
	time_updated: number;
	data: string;
}

export interface LoadedOpenCodeSession {
	session: OpenCodeSessionRow;
	messages: OpenCodeMessageRow[];
	partsByMessage: Map<string, OpenCodePartRow[]>;
	store: "v1" | "v2";
	/** 2.X `session_message` rows in seq order; empty for v1 sessions. */
	v2Rows: OpenCodeSessionMessageRow[];
}

export interface ConvertedUserMessage {
	role: "user";
	content: TextContent[];
	timestamp: number;
}

export interface ConvertedAssistantMessage {
	role: "assistant";
	content: ConvertedContent[];
	api: string;
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	timestamp: number;
}

export interface ConvertedCompaction {
	role: "compaction";
	summary: string;
	timestamp: number;
}

export type ConvertedMessage = ConvertedUserMessage | ConvertedAssistantMessage | ConvertedCompaction;

export interface ConvertedImport {
	title: string;
	provenance: string;
	model: { providerID: string; modelID: string } | null;
	messages: ConvertedMessage[];
	skipped: {
		malformedMessages: number;
		malformedParts: number;
		ignoredParts: number;
		nonTextFileParts: number;
		otherParts: number;
		emptyMessages: number;
	};
	lineageRuntime: "opencode";
	lineageId: string;
	canonicalId: string;
}

export interface ConvertOptions {
	maxToolChars?: number;
	importedAt?: Date;
}

export interface ListOptions {
	search?: string;
	cwd?: string;
	since?: number;
	updatedSince?: number;
	limit?: number;
	/** When true (default), exclude OpenCode delegated/subagent sessions (parent_id IS NOT NULL). */
	mainOnly?: boolean;
}

export interface ImportRegistryEntry {
	sourceSessionId: string;
	sourceDbPath: string;
	sourceUpdatedAt: number;
	sourceTitle: string;
	sourceDirectory: string;
	targetRuntime: "pi" | "omp" | string;
	targetSessionFile: string;
	importedAt: string;
	conversionVersion: number;
	messageCount: number;
	skippedCount: number;
}

export interface ImportRegistry {
	version: 1;
	imports: Record<string, ImportRegistryEntry>;
}

export interface BulkImportPlan {
	sessions: OpenCodeSessionRow[];
	toImport: OpenCodeSessionRow[];
	skippedAlreadyImported: OpenCodeSessionRow[];
	dryRun: boolean;
	force: boolean;
}

export interface BulkPlanOptions extends ListOptions {
	dryRun?: boolean;
	force?: boolean;
}

export interface RecordImportOptions {
	sourceSession: OpenCodeSessionRow;
	converted: ConvertedImport;
	runtime: "pi" | "omp" | string;
	targetSessionFile: string;
	sourceDbPath: string;
	importedAt?: Date;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_MAX_TOOL_CHARS = 4000;
export const SQLITE_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
export const TOOL_OUTPUT_LOAD_CHARS = 100_000;
export const CONVERSION_VERSION = 3;
export const CUSTOM_MESSAGE_TYPE = "opencode-import";
export const CANONICAL_NAMESPACE_UUID = "6e7b9c2a-3f4d-5e1f-a8b7-1c2d3e4f5a6b";

export function uuidv5(name: string, namespace: string): string {
	const nsBytes = parseUuidBytes(namespace);
	const nameBytes = Buffer.from(name, "utf8");
	const hash = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return formatUuidBytes(bytes);
}

export function canonicalIdFor(lineageRuntime: "opencode" | "pi" | "omp", lineageId: string): string {
	return lineageRuntime === "opencode" ? uuidv5(`opencode:${lineageId}`, CANONICAL_NAMESPACE_UUID) : lineageId;
}

export function findSessionFileByCanonicalId(sessionsDir: string, canonicalId: string): string | undefined {
	if (!existsSync(sessionsDir)) return undefined;
	const suffix = `_${canonicalId}.jsonl`;
	for (const entry of readdirSync(sessionsDir)) {
		if (entry.endsWith(suffix)) return `${sessionsDir}/${entry}`;
	}
	return undefined;
}

function parseUuidBytes(uuid: string): Buffer {
	const hex = uuid.replace(/-/g, "");
	if (hex.length !== 32) throw new Error(`Invalid UUID namespace: ${uuid}`);
	return Buffer.from(hex, "hex");
}

function formatUuidBytes(bytes: Buffer): string {
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function resolveDefaultDbPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : `${home}/.local/share`;
	return `${dataHome}/opencode/opencode.db`;
}

export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function runSqliteJson<T extends JsonObject>(dbPath: string, sql: string): T[] {
	if (!existsSync(dbPath)) {
		throw new Error(`OpenCode database not found: ${dbPath}. Use --db <path> to choose another database.`);
	}

	const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
		encoding: "utf8",
		maxBuffer: SQLITE_MAX_BUFFER_BYTES,
		timeout: 120_000,
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error("/usr/bin/sqlite3 (or sqlite3 on PATH) is required for /opencode-import.");
		throw result.error;
	}
	if (result.signal === "SIGTERM") throw new Error(`sqlite3 query timed out after 120s`);
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || `sqlite3 exited with ${result.status}`).trim());

	const output = result.stdout.trim();
	if (output.length === 0) return [];
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed)) throw new Error("sqlite3 returned non-array JSON");
	return parsed as T[];
}

/** Which OpenCode session stores exist in this database (1.X has `session`, 2.X adds `session_v2`). */
function existingSessionStores(dbPath: string): Array<"v1" | "v2"> {
	const names = runSqliteJson<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'session_v2')");
	const set = new Set(names.map((row) => row.name));
	const stores: Array<"v1" | "v2"> = [];
	if (set.has("session")) stores.push("v1");
	if (set.has("session_v2")) stores.push("v2");
	return stores;
}

const SESSION_COLUMNS = "id, project_id, parent_id, directory, COALESCE(title, '') AS title, version, time_created, time_updated, agent, model";

export function listOpenCodeSessions(dbPath: string, options: ListOptions = {}): OpenCodeSessionRow[] {
	const limit = clampLimit(options.limit);
	const predicates = ["time_archived IS NULL"];
	if (options.search?.trim()) {
		const search = sqlString(options.search.trim());
		predicates.push(`(lower(COALESCE(title, '')) LIKE lower('%' || ${search} || '%') OR lower(directory) LIKE lower('%' || ${search} || '%') OR id = ${search})`);
	}
	if (options.cwd?.trim()) predicates.push(`directory = ${sqlString(options.cwd.trim())}`);
	if (options.since !== undefined) predicates.push(`time_created >= ${integerLiteral(options.since)}`);
	if (options.updatedSince !== undefined) predicates.push(`time_updated >= ${integerLiteral(options.updatedSince)}`);
	if (options.mainOnly !== false) predicates.push("parent_id IS NULL");

	const stores = existingSessionStores(dbPath);
	const selects = stores.map(
		(store) => `SELECT ${SESSION_COLUMNS}, '${store}' AS store FROM ${store === "v1" ? "session" : "session_v2"} WHERE ${predicates.join(" AND ")}`,
	);
	if (selects.length === 0) return [];
	return runSqliteJson<OpenCodeSessionRow>(
		dbPath,
		`SELECT * FROM (${selects.join(" UNION ALL ")}) ORDER BY time_updated DESC, id DESC LIMIT ${limit}`,
	);
}

export function loadOpenCodeSession(dbPath: string, sessionId: string): LoadedOpenCodeSession {
	const stores = existingSessionStores(dbPath);
	if (stores.includes("v2")) {
		const sessions = runSqliteJson<OpenCodeSessionRow>(
			dbPath,
			`SELECT ${SESSION_COLUMNS}, 'v2' AS store FROM session_v2 WHERE id = ${sqlString(sessionId)} LIMIT 1`,
		);
		if (sessions[0]) {
			const rows = runSqliteJson<OpenCodeSessionMessageRow>(
				dbPath,
				`SELECT id, session_id, type, seq, time_created, time_updated, data
				 FROM session_message
				 WHERE session_id = ${sqlString(sessionId)}
				 ORDER BY seq ASC, id ASC`,
			);
			return { session: sessions[0], messages: [], partsByMessage: new Map(), store: "v2", v2Rows: rows };
		}
	}
	if (stores.includes("v1")) {
		const sessions = runSqliteJson<OpenCodeSessionRow>(
			dbPath,
			`SELECT ${SESSION_COLUMNS}, 'v1' AS store FROM session WHERE id = ${sqlString(sessionId)} LIMIT 1`,
		);
		const session = sessions[0];
		if (session) {
			const messages = runSqliteJson<OpenCodeMessageRow>(
				dbPath,
				`SELECT id, session_id, time_created, time_updated, data
				 FROM message
				 WHERE session_id = ${sqlString(sessionId)}
				 ORDER BY time_created ASC, id ASC`,
			);
			const parts = runSqliteJson<OpenCodePartRow>(
				dbPath,
				`SELECT id,
				        message_id,
				        session_id,
				        time_created,
				        time_updated,
				        CASE
				          WHEN json_valid(data)
				               AND json_extract(data, '$.type') = 'file'
				               AND coalesce(json_extract(data, '$.mime'), '') <> 'text/plain'
				            THEN json_remove(data, '$.url')
				          WHEN json_valid(data)
				               AND json_extract(data, '$.type') = 'tool'
				               AND json_type(data, '$.state.output') = 'text'
				            THEN json_set(data, '$.state.output', substr(json_extract(data, '$.state.output'), 1, ${TOOL_OUTPUT_LOAD_CHARS}))
				          ELSE data
				        END AS data
				 FROM part
				 WHERE session_id = ${sqlString(sessionId)}
				 ORDER BY message_id ASC, time_created ASC, id ASC`,
			);

			const partsByMessage = new Map<string, OpenCodePartRow[]>();
			for (const part of parts) {
				const messageParts = partsByMessage.get(part.message_id);
				if (messageParts) messageParts.push(part);
				else partsByMessage.set(part.message_id, [part]);
			}

			return { session, messages, partsByMessage, store: "v1", v2Rows: [] };
		}
	}
	throw new Error(`OpenCode session not found: ${sessionId}`);
}

export function getDbMtimeMs(dbPath: string): number {
	return statSync(dbPath).mtimeMs;
}

export function assertDbUnchanged(dbPath: string, expectedMtimeMs: number): void {
	const actual = getDbMtimeMs(dbPath);
	if (actual !== expectedMtimeMs) throw new Error(`OpenCode database mtime changed during import: ${expectedMtimeMs} -> ${actual}`);
}

export function convertOpenCodeSession(loaded: LoadedOpenCodeSession, options: ConvertOptions = {}): ConvertedImport {
	const maxToolChars = Math.max(0, options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS);
	const importedAt = options.importedAt ?? new Date();
	const messages: ConvertedMessage[] = [];
	const skipped: ConvertedImport["skipped"] = {
		malformedMessages: 0,
		malformedParts: 0,
		ignoredParts: 0,
		nonTextFileParts: 0,
		otherParts: 0,
		emptyMessages: 0,
	};
	let model: ConvertedImport["model"] = null;

	for (const messageRow of loaded.messages) {
		const messageData = parseJsonObject(messageRow.data);
		if (!messageData) {
			skipped.malformedMessages += 1;
			continue;
		}

		const role = readString(messageData.role);
		const messageParts = loaded.partsByMessage.get(messageRow.id) ?? [];
		const userBlocks: TextContent[] = [];
		const assistantBlocks: ConvertedContent[] = [];

		for (const partRow of messageParts) {
			const partData = parseJsonObject(partRow.data);
			if (!partData) {
				skipped.malformedParts += 1;
				continue;
			}
			if (isIgnoredPart(partData)) {
				skipped.ignoredParts += 1;
				continue;
			}

			const partType = readString(partData.type);
			if (partType === "text") {
				const text = readString(partData.text)?.trim();
				if (text) pushText(role === "assistant" ? assistantBlocks : userBlocks, text);
				continue;
			}

			if (partType === "file") {
				const converted = convertFilePart(partData);
				if (converted) pushText(role === "assistant" ? assistantBlocks : userBlocks, converted);
				else skipped.nonTextFileParts += 1;
				continue;
			}

			if (role === "assistant" && partType === "reasoning") {
				const reasoning = readString(partData.text)?.trim();
				if (reasoning) pushText(assistantBlocks, `[OpenCode reasoning]\n${reasoning}`);
				continue;
			}

			if (role === "assistant" && partType === "tool") {
				const serialized = serializeToolPart(partData, maxToolChars);
				if (serialized) pushText(assistantBlocks, serialized);
				continue;
			}

			if (partType !== "step-start" && partType !== "step-finish") skipped.otherParts += 1;
		}

		if (role === "user") {
			if (userBlocks.length === 0) {
				skipped.emptyMessages += 1;
				continue;
			}
			messages.push({ role: "user", content: userBlocks, timestamp: readTimestamp(messageData, messageRow.time_created) });
			continue;
		}

		if (role === "assistant") {
			const modelObj = messageData.model && typeof messageData.model === "object" ? (messageData.model as JsonObject) : undefined;
			const providerID = readString(messageData.providerID) ?? readString(modelObj?.providerID) ?? "opencode";
			const modelID = readString(messageData.modelID) ?? readString(modelObj?.modelID) ?? loaded.session.model ?? "unknown";
			model = { providerID, modelID };
			if (assistantBlocks.length === 0) {
				skipped.emptyMessages += 1;
				continue;
			}
			messages.push({
				role: "assistant",
				content: assistantBlocks,
				api: readString(messageData.api) ?? providerToApi(providerID),
				provider: providerID,
				model: modelID,
				usage: usageFromMessage(messageData),
				stopReason: finishToStopReason(readString(messageData.finish)),
				timestamp: readTimestamp(messageData, messageRow.time_created),
			});
			continue;
		}

		skipped.emptyMessages += 1;
	}

	if (loaded.store === "v2") {
		const v2model = convertV2Rows(loaded.v2Rows, loaded.session, messages, skipped, maxToolChars);
		if (v2model) model = v2model;
	}

	const title = `[opencode] ${loaded.session.title || loaded.session.id}`;
	const provenance = buildProvenance(loaded, skipped, importedAt, messages.length);
	const lineageId = loaded.session.id;
	const canonicalId = canonicalIdFor("opencode", lineageId);
	return { title, provenance, model, messages, skipped, lineageRuntime: "opencode", lineageId, canonicalId };
}

/** Convert 2.X `session_message` rows (content already inline, no `part` table). */
function convertV2Rows(
	rows: OpenCodeSessionMessageRow[],
	session: OpenCodeSessionRow,
	messages: ConvertedMessage[],
	skipped: ConvertedImport["skipped"],
	maxToolChars: number,
): ConvertedImport["model"] {
	let model: ConvertedImport["model"] = null;
	for (const row of rows) {
		const data = parseJsonObject(row.data);
		if (!data) {
			skipped.malformedMessages += 1;
			continue;
		}
		const type = readString(row.type) ?? "unknown";
		const timestamp = readTimestamp(data, row.time_created);

		if (type === "user") {
			const blocks: TextContent[] = [];
			const text = readString(data.text)?.trim();
			if (text) pushText(blocks, text);
			const files = Array.isArray(data.files) ? data.files : [];
			for (const file of files) {
				const converted = convertV2File(file);
				if (converted) pushText(blocks, converted);
				else skipped.nonTextFileParts += 1;
			}
			if (blocks.length === 0) {
				skipped.emptyMessages += 1;
				continue;
			}
			messages.push({ role: "user", content: blocks, timestamp });
			continue;
		}

		if (type === "assistant") {
			const modelObj = data.model && typeof data.model === "object" ? (data.model as JsonObject) : undefined;
			const providerID = readString(modelObj?.providerID) ?? "opencode";
			const modelID = readString(modelObj?.id) ?? readString(modelObj?.modelID) ?? session.model ?? "unknown";
			model = { providerID, modelID };
			const blocks: ConvertedContent[] = [];
			const content = Array.isArray(data.content) ? data.content : [];
			for (const block of content) {
				if (!block || typeof block !== "object") {
					skipped.malformedParts += 1;
					continue;
				}
				const blockType = readString((block as JsonObject).type);
				if (blockType === "text") {
					const text = readString((block as JsonObject).text)?.trim();
					if (text) pushText(blocks, text);
					continue;
				}
				if (blockType === "reasoning") {
					const reasoning = readString((block as JsonObject).text)?.trim();
					if (reasoning) pushText(blocks, `[OpenCode reasoning]\n${reasoning}`);
					continue;
				}
				if (blockType === "tool") {
					const serialized = serializeV2Tool(block as JsonObject, maxToolChars);
					if (serialized) pushText(blocks, serialized);
					continue;
				}
				skipped.otherParts += 1;
			}
			if (blocks.length === 0) {
				skipped.emptyMessages += 1;
				continue;
			}
			messages.push({
				role: "assistant",
				content: blocks,
				api: providerToApi(providerID),
				provider: providerID,
				model: modelID,
				usage: usageFromMessage(data),
				stopReason: finishToStopReason(readString(data.finish)),
				timestamp,
			});
			continue;
		}

		if (type === "compaction") {
			const summary = readString(data.summary)?.trim();
			if (!summary) {
				skipped.emptyMessages += 1;
				continue;
			}
			messages.push({ role: "compaction", summary, timestamp });
			continue;
		}

		skipped.otherParts += 1;
	}
	return model;
}

function convertV2File(file: unknown): string | null {
	if (!file || typeof file !== "object") return null;
	const data = file as JsonObject;
	const mime = readString(data.mime);
	const name = readString(data.name) ?? "attachment";
	if (mime !== "text/plain") return `[OpenCode file: ${name} (${mime ?? "unknown"})]`;
	const raw = readString(data.data);
	if (!raw) return `[OpenCode file: ${name} (${mime})]`;
	const body = textFromDataUrl(raw) ?? (raw.length <= 4000 ? raw : undefined);
	if (!body) return `[OpenCode file: ${name} (${mime})]`;
	return `[OpenCode file: ${name} (${mime})]\n${body}`;
}

function serializeV2Tool(block: JsonObject, maxToolChars: number): string | null {
	const tool = readString(block.name) ?? "unknown";
	const callID = readString(block.id) ?? "unknown";
	const state = (block.state && typeof block.state === "object" ? block.state : {}) as JsonObject;
	const status = readString(state.status) ?? "unknown";
	const input = state.input === undefined ? undefined : safeStringify(state.input);
	const output = textFromV2ToolContent(state.content);
	const lines = [`[OpenCode tool call: ${tool} (${status}) id=${callID}]`];
	if (input) lines.push(`input: ${input}`);
	if (maxToolChars > 0 && output) {
		const capped = output.length > maxToolChars ? `${output.slice(0, maxToolChars)}\n[truncated ${output.length - maxToolChars} chars]` : output;
		lines.push(`output:\n${capped}`);
	}
	return lines.join("\n");
}

function textFromV2ToolContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const text = readString((block as JsonObject).text)?.trim();
			if (text) texts.push(text);
		}
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

export function loadImportRegistry(path: string): ImportRegistry {
	if (!existsSync(path)) return { version: 1, imports: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return { version: 1, imports: {} };
		const registry = parsed as Partial<ImportRegistry>;
		return { version: 1, imports: registry.imports && typeof registry.imports === "object" ? registry.imports : {} };
	} catch {
		return { version: 1, imports: {} };
	}
}

export function saveImportRegistry(path: string, registry: ImportRegistry): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
}

export function registryKey(runtime: string, sourceSessionId: string): string {
	return `${runtime}:${sourceSessionId}`;
}

export function recordImportedSession(registry: ImportRegistry, options: RecordImportOptions): ImportRegistryEntry {
	const entry: ImportRegistryEntry = {
		sourceSessionId: options.sourceSession.id,
		sourceDbPath: options.sourceDbPath,
		sourceUpdatedAt: options.sourceSession.time_updated,
		sourceTitle: options.sourceSession.title,
		sourceDirectory: options.sourceSession.directory,
		targetRuntime: options.runtime,
		targetSessionFile: options.targetSessionFile,
		importedAt: (options.importedAt ?? new Date()).toISOString(),
		conversionVersion: CONVERSION_VERSION,
		messageCount: options.converted.messages.length,
		skippedCount: totalSkipped(options.converted),
	};
	registry.imports[registryKey(options.runtime, options.sourceSession.id)] = entry;
	return entry;
}

export function getImportedSession(registry: ImportRegistry, runtime: string, sourceSessionId: string): ImportRegistryEntry | undefined {
	return registry.imports[registryKey(runtime, sourceSessionId)];
}

export function planBulkImport(dbPath: string, registry: ImportRegistry, options: BulkPlanOptions = {}, runtime = "omp"): BulkImportPlan {
	const sessions = listOpenCodeSessions(dbPath, options);
	const force = Boolean(options.force);
	const toImport: OpenCodeSessionRow[] = [];
	const skippedAlreadyImported: OpenCodeSessionRow[] = [];
	for (const session of sessions) {
		if (!force && getImportedSession(registry, runtime, session.id)) skippedAlreadyImported.push(session);
		else toImport.push(session);
	}
	return { sessions, toImport, skippedAlreadyImported, dryRun: Boolean(options.dryRun), force };
}

export function formatSessionList(sessions: OpenCodeSessionRow[], registry?: ImportRegistry, runtime = "omp"): string {
	if (sessions.length === 0) return "No OpenCode sessions found.";
	return sessions.map((session) => {
		const imported = registry && getImportedSession(registry, runtime, session.id) ? "imported" : "pending";
		const when = formatIso(session.time_updated).slice(0, 16).replace("T", " ");
		return `${session.title || session.id} · ${imported} · ${session.store} · ${when} · ${session.directory} · ${session.id}`;
	}).join("\n");
}

export function formatImportStatus(plan: BulkImportPlan, registry: ImportRegistry, runtime?: string): string {
	const importedEntries = Object.values(registry.imports).filter((entry) => runtime === undefined || entry.targetRuntime === runtime);
	const importedIds = new Set(importedEntries.map((entry) => entry.sourceSessionId));
	const pendingSessions = plan.sessions.filter((session) => !importedIds.has(session.id));
	const lines = [
		`OpenCode import status${runtime ? ` (${runtime})` : ""}`,
		`Imported: ${importedEntries.length}`,
		`Pending: ${pendingSessions.length}`,
		`Already imported in this selection: ${plan.skippedAlreadyImported.length}`,
	];
	for (const entry of importedEntries.slice(0, 20)) {
		lines.push(`${entry.sourceSessionId}\t${entry.sourceTitle}\t${entry.targetSessionFile}`);
	}
	if (pendingSessions.length > 0) {
		lines.push("Pending sessions:");
		for (const session of pendingSessions.slice(0, 20)) lines.push(`${session.id}\t${session.title}\t${session.directory}`);
	}
	return lines.join("\n");
}

export function totalSkipped(converted: ConvertedImport): number {
	return Object.values(converted.skipped).reduce((sum, value) => sum + value, 0);
}

export function skippedSummary(converted: ConvertedImport): string {
	return `${totalSkipped(converted)} skipped items`;
}

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

function integerLiteral(value: number): number {
	if (!Number.isFinite(value)) throw new Error(`Expected finite timestamp, got ${value}`);
	return Math.trunc(value);
}

function parseJsonObject(json: string): JsonObject | null {
	try {
		const parsed = JSON.parse(json) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimestamp(messageData: JsonObject, fallback: number): number {
	const time = messageData.time as JsonObject | undefined;
	return readNumber(time?.created) ?? fallback;
}

function isIgnoredPart(partData: JsonObject): boolean {
	const metadata = partData.metadata as JsonObject | undefined;
	return Boolean(partData.synthetic || partData.ignore || partData.ignored || metadata?.synthetic || metadata?.ignore || metadata?.ignored);
}

function pushText(blocks: ConvertedContent[] | TextContent[], text: string): void {
	blocks.push({ type: "text", text });
}

function convertFilePart(partData: JsonObject): string | null {
	const mime = readString(partData.mime) ?? readString(partData.mediaType) ?? readString(partData.type_mime);
	if (mime !== "text/plain") return null;
	const filename = readString(partData.filename) ?? readString(partData.name) ?? "text attachment";
	const body = readString(partData.text) ?? readString(partData.content) ?? textFromDataUrl(readString(partData.url));
	if (!body) return `[OpenCode file: ${filename} (${mime})]`;
	return `[OpenCode file: ${filename} (${mime})]\n${body}`;
}

function textFromDataUrl(url: string | undefined): string | undefined {
	if (!url?.startsWith("data:text/plain")) return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	try {
		return header.includes(";base64") ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
	} catch {
		return undefined;
	}
}

function serializeToolPart(partData: JsonObject, maxToolChars: number): string | null {
	const tool = readString(partData.tool) ?? "unknown";
	const callID = readString(partData.callID) ?? readString(partData.id) ?? "unknown";
	const state = (partData.state && typeof partData.state === "object" ? partData.state : {}) as JsonObject;
	const status = readString(state.status) ?? "unknown";
	const input = state.input === undefined ? undefined : safeStringify(state.input);
	const output = readString(state.output) ?? readString((state.metadata as JsonObject | undefined)?.output);
	const lines = [`[OpenCode tool call: ${tool} (${status}) id=${callID}]`];
	if (input) lines.push(`input: ${input}`);
	if (maxToolChars > 0 && output) {
		const capped = output.length > maxToolChars ? `${output.slice(0, maxToolChars)}\n[truncated ${output.length - maxToolChars} chars]` : output;
		lines.push(`output:\n${capped}`);
	}
	return lines.join("\n");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function providerToApi(providerID: string): string {
	switch (providerID) {
		case "anthropic":
			return "anthropic-messages";
		case "google":
			return "google-generative-ai";
		case "openai":
			return "openai-responses";
		default:
			return providerID;
	}
}

function usageFromMessage(messageData: JsonObject): ConvertedAssistantMessage["usage"] {
	const tokens = (messageData.tokens && typeof messageData.tokens === "object" ? messageData.tokens : {}) as JsonObject;
	const cache = (tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {}) as JsonObject;
	const input = readNumber(tokens.input) ?? 0;
	const output = readNumber(tokens.output) ?? 0;
	const cacheRead = readNumber(cache.read) ?? 0;
	const cacheWrite = readNumber(cache.write) ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: readNumber(tokens.total) ?? input + output + cacheRead + cacheWrite + (readNumber(tokens.reasoning) ?? 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: readNumber(messageData.cost) ?? 0 },
	};
}

function finishToStopReason(finish: string | undefined): ConvertedAssistantMessage["stopReason"] {
	if (finish === "length") return "length";
	if (finish === "tool-calls" || finish === "tool_use") return "toolUse";
	if (finish === "error") return "error";
	if (finish === "aborted") return "aborted";
	return "stop";
}

function buildProvenance(loaded: LoadedOpenCodeSession, skipped: ConvertedImport["skipped"], importedAt: Date, messageCount: number): string {
	return [
		`Imported from OpenCode session ${loaded.session.id}`,
		`Title: ${loaded.session.title}`,
		`Directory: ${loaded.session.directory}`,
		`OpenCode store: ${loaded.store} (schema ${loaded.session.version})`,
		`Conversion version: ${CONVERSION_VERSION}`,
		`Imported at: ${importedAt.toISOString()}`,
		`Imported Pi messages: ${messageCount}`,
		`Skipped ignored parts: ${skipped.ignoredParts}`,
		`Skipped non-text file parts: ${skipped.nonTextFileParts}`,
		`Skipped malformed messages: ${skipped.malformedMessages}`,
		`Skipped malformed parts: ${skipped.malformedParts}`,
	].join("\n");
}

export interface SessionFileBuildOptions {
	runtime: "pi" | "omp";
	cwd: string;
	parentSession?: string;
	timestamp?: Date;
}

export interface BuiltSessionFile {
	content: string;
	fileName: string;
	sessionId: string;
}

export function buildSessionFileContent(converted: ConvertedImport, options: SessionFileBuildOptions): BuiltSessionFile {
	const timestamp = options.timestamp ?? new Date();
	const isoTs = timestamp.toISOString();
	const sessionId = converted.canonicalId;
	const fileTimestamp = isoTs.replace(/[:.]/g, "-");
	const fileName = `${fileTimestamp}_${sessionId}.jsonl`;
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: isoTs,
		cwd: options.cwd,
	};
	if (options.parentSession) header.parentSession = options.parentSession;
	if (options.runtime === "omp") {
		header.title = converted.title;
		header.titleSource = "user";
	}
	const entries: Record<string, unknown>[] = [];
	let parentId: string | null = null;
	const push = (entry: Record<string, unknown>) => {
		const id = randomEntryId();
		const full = { ...entry, id, parentId, timestamp: isoTs };
		entries.push(full);
		parentId = id;
	};
	if (options.runtime === "pi") push({ type: "session_info", name: converted.title });
	push({
		type: "custom_message",
		customType: CUSTOM_MESSAGE_TYPE,
		content: converted.provenance,
		display: true,
		details: {
			source: "opencode",
			lineageRuntime: converted.lineageRuntime,
			lineageId: converted.lineageId,
			canonicalId: converted.canonicalId,
		},
	});
	if (converted.model) {
		if (options.runtime === "omp") {
			push({ type: "model_change", model: `${converted.model.providerID}/${converted.model.modelID}` });
		} else {
			push({ type: "model_change", provider: converted.model.providerID, modelId: converted.model.modelID });
		}
	}
	for (const message of converted.messages) {
		if (message.role === "compaction") {
			push({ type: "compaction", summary: message.summary });
			continue;
		}
		push({ type: "message", message });
	}
	const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
	return { content: `${lines.join("\n")}\n`, fileName, sessionId };
}

function randomEntryId(): string {
	const bytes = createHash("sha1").update(`${process.hrtime.bigint()}-${Math.random()}`).digest("hex");
	return bytes.slice(0, 8);
}

function formatIso(value: number): string {
	return new Date(value).toISOString();
}
