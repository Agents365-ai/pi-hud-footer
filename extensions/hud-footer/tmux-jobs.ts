// Tmux job line for the footer: panes on the agent tmux socket that belong to
// THIS pi process, i.e. created with `-e PI_HUD_OWNER=<pi pid>`.
//
// Local addition to the vendored pi-hud-footer package (not upstream). Panes are
// polled because the footer cannot be notified when a worker appears or dies.
import { execFile } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TMUX_SOCKET = "pi-agent";
const POLL_MS = 2000;
const MAX_NAME = 24;
const MIN_NAME = 8;
// Screen budget for the jobs block: one row hides most entries, an unbounded
// block pushes the transcript away.
const MAX_ROWS = 3;
// tmux 3.7c has no #{pane_created}, it expands to an empty string.
const FORMAT =
	"#{session_name}\t#{pane_current_command}\t#{pane_dead}\t#{E:PI_HUD_OWNER}\t#{session_created}\t#{pane_id}";
const LABEL = "jobs ";
const SEPARATOR = " \u00b7 ";
const CONTINUATION = "  ";
const ELLIPSIS = "\u2026";
const LABEL_WIDTH = visibleWidth(LABEL);
const SEPARATOR_WIDTH = visibleWidth(SEPARATOR);
const CONTINUATION_WIDTH = visibleWidth(CONTINUATION);

type Theme = ExtensionContext["ui"]["theme"];

export type TmuxJob = { name: string; cmd: string; dead: boolean; created: number; id: number };

type Packed = { rows: string[]; shown: number };

function sameJobs(a: TmuxJob[], b: TmuxJob[]): boolean {
	return a.length === b.length &&
		a.every((job, i) => job.name === b[i].name && job.cmd === b[i].cmd && job.dead === b[i].dead);
}

function listJobs(): Promise<TmuxJob[]> {
	return new Promise((resolve) => {
		execFile(
			"tmux",
			["-L", TMUX_SOCKET, "list-panes", "-a", "-F", FORMAT],
			{ timeout: 1500 },
			(error, stdout) => {
				if (error) return resolve([]);
				const owner = String(process.pid);
				const jobs: TmuxJob[] = [];
				for (const line of stdout.split("\n")) {
					if (!line.trim()) continue;
					const [name, cmd, dead, tag, created, id] = line.split("\t");
					if (tag !== owner) continue; // untagged panes belong to no footer
					jobs.push({
						name: name ?? "",
						cmd: cmd ?? "",
						dead: dead === "1",
						created: Number(created) || 0,
						id: Number((id ?? "").slice(1)) || 0,
					});
				}
				// Live panes first, then finished panes, newest first in both groups, so
				// the tail of the list holds the oldest finished panes: that is what the
				// renderer drops first.
				jobs.sort((a, b) => Number(a.dead) - Number(b.dead) || b.created - a.created || b.id - a.id);
				resolve(jobs);
			},
		);
	});
}

export function createTmuxJobsWatcher(onChange: () => void) {
	let jobs: TmuxJob[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	async function tick(): Promise<void> {
		const next = await listJobs();
		if (sameJobs(next, jobs)) return;
		jobs = next;
		onChange();
	}

	void tick();
	timer = setInterval(() => void tick(), POLL_MS);

	return {
		list: (): TmuxJob[] => jobs,
		dispose(): void {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
	};
}

function jobText(job: TmuxJob, theme: Theme, budget: number): string {
	const name = job.name.length > budget ? job.name.slice(0, budget - 1) + ELLIPSIS : job.name;
	const text = `${name}(${job.cmd})${job.dead ? " \u271d" : ""}`;
	return job.dead ? theme.fg("muted", text) : theme.fg("accent", text);
}

// Pack entries into at most MAX_ROWS rows. `shown` is the number of entries that
// fit at the given name budget.
function packRows(parts: string[], theme: Theme, width: number): Packed {
	const separator = theme.fg("muted", SEPARATOR);
	const rows: string[] = [];
	let row = theme.fg("muted", LABEL);
	let rowWidth = LABEL_WIDTH;
	let rowParts = 0;
	let shown = 0;

	for (const part of parts) {
		const partWidth = visibleWidth(part);
		if (rowParts > 0 && rowWidth + SEPARATOR_WIDTH + partWidth > width) {
			if (rows.length + 1 >= MAX_ROWS) break;
			rows.push(row);
			row = CONTINUATION;
			rowWidth = CONTINUATION_WIDTH;
			rowParts = 0;
		}
		if (rowParts > 0) {
			row += separator;
			rowWidth += SEPARATOR_WIDTH;
		}
		row += part;
		rowWidth += partWidth;
		rowParts += 1;
		shown += 1;
	}

	if (rowParts > 0) rows.push(row);
	return { rows, shown };
}

// Names are shortened only when the shorter name removes a whole row: the job
// name is the part people read, and the hidden count is reported either way.
function packBest(jobs: TmuxJob[], theme: Theme, width: number): Packed {
	let best = packRows(jobs.map((job) => jobText(job, theme, MAX_NAME)), theme, width);
	for (let budget = MAX_NAME - 2; budget >= MIN_NAME; budget -= 2) {
		if (best.rows.length === 1) break;
		const packed = packRows(jobs.map((job) => jobText(job, theme, budget)), theme, width);
		if (packed.rows.length < best.rows.length) best = packed;
	}
	return best;
}

export function renderTmuxJobsLines(jobs: TmuxJob[], theme: Theme, width: number, maxJobs: number): string[] {
	if (jobs.length === 0 || width <= 0) return [];
	const visible = jobs.slice(0, Math.max(1, maxJobs));

	let packed = packBest(visible, theme, width);
	const dropped = jobs.length - packed.shown;
	if (dropped > 0) {
		// Reserve room for the marker on the last row.
		packed = packBest(visible, theme, Math.max(1, width - visibleWidth(`+${dropped}`) - 1));
	}

	const rows = packed.rows.map((row) => truncateToWidth(row, width, ELLIPSIS));
	const hidden = jobs.length - packed.shown;
	if (hidden > 0) {
		const marker = theme.fg("muted", `+${hidden}`);
		const last = rows.length - 1;
		rows[last] = `${truncateToWidth(rows[last], Math.max(0, width - visibleWidth(marker) - 1), ELLIPSIS)} ${marker}`;
	}
	return rows;
}
