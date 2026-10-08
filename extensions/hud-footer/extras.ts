// Extras line: rtk session savings, MCP server and tool counts, project memory entries.
//
// Local addition to the vendored pi-hud-footer package (not upstream). Every segment hides
// itself when its source is missing: no rtk binary, no MCP server, no memory store. A line
// with no visible segment returns undefined, so a session that has none of the three keeps
// the footer height it had before.
//
// Collection runs off the render path (session start, agent end, config reload). An
// `rtk gain` call measured 0.33 s, so it never runs inside a repaint.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isDisplayEnabled } from "./config.ts";
import { fmtPercent, fmtTokens } from "./format.ts";
import { getI18n } from "./i18n.ts";
import type { HudConfig } from "./types.ts";

type Theme = ExtensionContext["ui"]["theme"];

const EXEC_TIMEOUT_MS = 5_000;
const RTK_BASELINE_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;

export type RtkTotals = { commands: number; saved: number; input: number };

export type HudExtras = {
	rtk?: { saved: number; pct: number };
	mcp?: { servers: number; tools?: number };
	memory?: number;
};

function agentConfigPath(file: string): string {
	return join(homedir(), ".pi", "agent", file);
}

/** Runs a command and returns its stdout, or undefined when it fails or is missing. */
function execText(command: string, args: string[], cwd: string | undefined, timeout: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Account-wide rtk totals from the history database. */
export async function readRtkTotals(): Promise<RtkTotals | undefined> {
	const stdout = await execText("rtk", ["gain", "-f", "json"], undefined, RTK_BASELINE_TIMEOUT_MS);
	if (!stdout) return undefined;
	const parsed = (() => {
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			return undefined;
		}
	})();
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const summary = (parsed as { summary?: unknown }).summary;
	if (typeof summary !== "object" || summary === null) return undefined;
	const commands = finite((summary as Record<string, unknown>).total_commands);
	const saved = finite((summary as Record<string, unknown>).total_saved);
	const input = finite((summary as Record<string, unknown>).total_input);
	if (commands === undefined || saved === undefined || input === undefined) return undefined;
	return { commands, saved, input };
}

/**
 * Savings added since the baseline read. `rtk gain` reports account-wide totals and the
 * history database is shared by every session on the machine, so the delta also counts
 * commands from concurrent sessions.
 */
export function sessionRtk(baseline: RtkTotals | undefined, totals: RtkTotals | undefined): HudExtras["rtk"] {
	if (!baseline || !totals) return undefined;
	const commands = totals.commands - baseline.commands;
	const saved = totals.saved - baseline.saved;
	const input = totals.input - baseline.input;
	// A negative or zero delta means nothing was filtered yet, or the database was reset.
	if (commands <= 0 || saved <= 0 || input <= 0) return undefined;
	return { saved, pct: Math.min(1, saved / input) };
}

function configServerNames(file: string): string[] {
	const parsed = readJson(agentConfigPath(file));
	if (typeof parsed !== "object" || parsed === null) return [];
	const servers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
	return Object.keys(servers);
}

/** Tool counts from pi-mcp-adapter's metadata cache, keyed by server name. */
function cachedToolCounts(): Map<string, number> {
	const parsed = readJson(agentConfigPath("mcp-cache.json"));
	if (typeof parsed !== "object" || parsed === null) return new Map();
	const servers = (parsed as { servers?: unknown }).servers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return new Map();
	const counts = new Map<string, number>();
	for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
		const tools = typeof entry === "object" && entry !== null ? (entry as { tools?: unknown }).tools : undefined;
		if (Array.isArray(tools)) counts.set(name, tools.length);
	}
	return counts;
}

/**
 * Servers registered with pi, which covers the builtin mcp.json and the servers
 * pi-mcp-adapter registers on pi's behalf. Older pi versions without `getMcpServers()`
 * fall back to the two config files. The cache keeps entries for servers that no longer
 * exist, so tool counts are only taken for the names found above.
 */
function mcpSegment(pi: ExtensionAPI): HudExtras["mcp"] {
	const registered = (() => {
		try {
			return typeof pi.getMcpServers === "function" ? pi.getMcpServers().map((server) => server.name) : [];
		} catch {
			return [];
		}
	})();
	const names = [...new Set(registered.length > 0
		? registered
		: [...configServerNames("mcp.json"), ...configServerNames("mcp-adapter.json")])];
	if (names.length === 0) return undefined;

	const counts = cachedToolCounts();
	let tools = 0;
	let known = 0;
	for (const name of names) {
		const count = counts.get(name);
		if (count === undefined) continue;
		tools += count;
		known += 1;
	}
	return known > 0 ? { servers: names.length, tools } : { servers: names.length };
}

/** Store directory name for a project, same rule as the project-memory extension. */
function memorySlug(projectDir: string): string {
	return projectDir.replace(/[^a-zA-Z0-9-]/g, "-");
}

function entryCount(storeDir: string): number | undefined {
	// MEMORY.md marks a store the project-memory extension has initialized.
	if (!existsSync(join(storeDir, "MEMORY.md"))) return undefined;
	try {
		return readdirSync(storeDir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").length;
	} catch {
		return undefined;
	}
}

/** Entries in the memory store of the project root, falling back to the working directory. */
async function memorySegment(cwd: string): Promise<number | undefined> {
	const root = (await execText("git", ["rev-parse", "--show-toplevel"], cwd, GIT_TIMEOUT_MS))?.trim();
	const candidates = [...new Set([root, cwd].filter((dir): dir is string => Boolean(dir)))];
	for (const candidate of candidates) {
		const count = entryCount(join(homedir(), ".pi", "agent", "memory", memorySlug(candidate)));
		if (count !== undefined) return count;
	}
	return undefined;
}

// `cwd` is passed in rather than read from a context: a context captured in an event handler is
// stale after a session replacement or reload, and the caller reads it before its first await.
export async function collectExtras(
	pi: ExtensionAPI,
	cwd: string,
	rtk: HudExtras["rtk"],
): Promise<HudExtras> {
	const [mcp, memory] = await Promise.all([Promise.resolve(mcpSegment(pi)), memorySegment(cwd)]);
	const extras: HudExtras = {};
	if (rtk) extras.rtk = rtk;
	if (mcp) extras.mcp = mcp;
	if (memory) extras.memory = memory;
	return extras;
}

function segment(theme: Theme, label: string, value: string): string {
	return `${theme.fg("muted", label)} ${theme.fg("text", value)}`;
}

/** The extras line body, without the leading space the footer rows use. */
export function renderExtrasLine(extras: HudExtras, config: HudConfig, theme: Theme, width: number): string | undefined {
	const labels = getI18n(config.language).labels;
	const parts: string[] = [];

	if (extras.rtk && isDisplayEnabled(config, "rtkSavings")) {
		parts.push(segment(theme, labels.rtk, labels.rtkSaved(fmtTokens(extras.rtk.saved), fmtPercent(extras.rtk.pct))));
	}
	if (extras.mcp && isDisplayEnabled(config, "mcpStatus")) {
		parts.push(segment(theme, labels.mcp, labels.mcpStatus(extras.mcp.servers, extras.mcp.tools)));
	}
	if (extras.memory && isDisplayEnabled(config, "memoryCount")) {
		parts.push(segment(theme, labels.memory, labels.memoryEntries(extras.memory)));
	}

	if (parts.length === 0 || width <= 0) return undefined;
	return truncateToWidth(parts.join(theme.fg("dim", " | ")), width, "\u2026");
}
