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

type Theme = ExtensionContext["ui"]["theme"];

export type TmuxJob = { name: string; cmd: string; dead: boolean };

function sameJobs(a: TmuxJob[], b: TmuxJob[]): boolean {
	return a.length === b.length &&
		a.every((job, i) => job.name === b[i].name && job.cmd === b[i].cmd && job.dead === b[i].dead);
}

function listJobs(): Promise<TmuxJob[]> {
	return new Promise((resolve) => {
		execFile(
			"tmux",
			[
				"-L", TMUX_SOCKET,
				"list-panes", "-a", "-F",
				"#{session_name}\t#{pane_current_command}\t#{pane_dead}\t#{E:PI_HUD_OWNER}",
			],
			{ timeout: 1500 },
			(error, stdout) => {
				if (error) return resolve([]);
				const owner = String(process.pid);
				const jobs: TmuxJob[] = [];
				for (const line of stdout.split("\n")) {
					if (!line.trim()) continue;
					const [name, cmd, dead, tag] = line.split("\t");
					if (tag !== owner) continue; // untagged panes belong to no footer
					jobs.push({ name: name ?? "", cmd: cmd ?? "", dead: dead === "1" });
				}
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

export function renderTmuxJobsLine(jobs: TmuxJob[], theme: Theme, width: number): string | undefined {
	if (jobs.length === 0) return undefined;
	const parts = jobs.map((job) => {
		const name = job.name.length > MAX_NAME ? job.name.slice(0, MAX_NAME - 1) + "\u2026" : job.name;
		const text = `${name}(${job.cmd})${job.dead ? " \u271d" : ""}`;
		return job.dead ? theme.fg("muted", text) : theme.fg("accent", text);
	});
	const line = theme.fg("muted", "jobs ") + parts.join(theme.fg("muted", " \u00b7 "));
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "\u2026");
}
