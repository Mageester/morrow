import { ProcessOutputSchema, WebProcessSchema, type ProcessOutput, type WebProcess } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

/**
 * Background jobs — dev servers, watchers, anything the agent started with
 * `run_command background:true`.
 *
 * The orchestrator has supervised these durably for a long time, with log
 * capture, termination and startup reconciliation, and the browser had no
 * client for any of it. A dev server Morrow started was real, running, and
 * completely invisible to the person whose machine it was running on.
 */

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/processes`;
const processPath = (processId: string) => `/api/processes/${encodeURIComponent(processId)}`;

export const processKeys = {
  all: ["processes"] as const,
  list(projectId: string) {
    return [...this.all, projectId] as const;
  },
  output(processId: string, stream: "stdout" | "stderr") {
    return [...this.all, "output", processId, stream] as const;
  },
};

/**
 * A running job's state changes without anyone asking — it binds a port, it
 * crashes, it finishes compiling and only then announces its address. Polling
 * stops entirely once nothing is running, so an idle project costs nothing.
 */
const RUNNING_POLL_MS = 2_500;

const WebProcessListSchema = z.array(WebProcessSchema);

export const processQueries = {
  list(projectId: string) {
    return queryOptions<WebProcess[]>({
      queryKey: processKeys.list(projectId),
      queryFn: () => api.get(projectPath(projectId), WebProcessListSchema),
      enabled: Boolean(projectId),
      refetchInterval: (query) =>
        (query.state.data ?? []).some((entry) => entry.status === "running") ? RUNNING_POLL_MS : false,
    });
  },

  /**
   * The head of one stream. Deliberately not paged from an offset here: a log
   * viewer that a reader opens wants the startup banner, and re-reading a
   * bounded head keeps the query cache a single value per stream rather than
   * an accumulating buffer this surface would have to own.
   */
  output(processId: string, stream: "stdout" | "stderr", enabled: boolean) {
    return queryOptions<ProcessOutput>({
      queryKey: processKeys.output(processId, stream),
      queryFn: () =>
        api.get(`${processPath(processId)}/output?stream=${stream}&offset=0&limit=65536`, ProcessOutputSchema),
      enabled: enabled && Boolean(processId),
      refetchInterval: (query) => (query.state.data?.eof === false ? RUNNING_POLL_MS : false),
    });
  },
};

const TerminateResultSchema = z.object({
  status: z.string(),
  processId: z.string(),
  forced: z.boolean(),
}).passthrough();

export const processApi = {
  terminate(processId: string, force = false) {
    return api.post(`${processPath(processId)}/terminate`, { force }, TerminateResultSchema);
  },
};
