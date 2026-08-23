// Thin JSON wrapper: every dashboard fetch goes through here.
export class ApiError extends Error {
  constructor(status, message, details = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export async function request(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    const message = body?.error ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body?.details ?? []);
  }
  return body;
}

export const fetchProject = () => request("/api/project");

export const fetchMembers = () => request("/api/members");

export function fetchJobs({ limit = 50, cursor = null, state = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (state) params.set("state", state);
  return request(`/api/jobs?${params.toString()}`);
}

export function fetchJobCount(state = null) {
  const params = new URLSearchParams({ count: "true" });
  if (state) params.set("state", state);
  return request(`/api/jobs?${params.toString()}`);
}

export function createJob(input) {
  return request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateJob(id, patch) {
  return request(`/api/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export const cancelJob = (id) =>
  request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

export const claimJob = (id) =>
  request(`/api/jobs/${encodeURIComponent(id)}/claim`, { method: "POST" });

export function transitionJob(id, outcome, message = undefined) {
  return request(`/api/jobs/${encodeURIComponent(id)}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      message === undefined ? { outcome } : { outcome, message },
    ),
  });
}

export function setProgress(id, progress) {
  return request(`/api/jobs/${encodeURIComponent(id)}/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ progress }),
  });
}

export function addNote(id, note) {
  return request(`/api/jobs/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note }),
  });
}
