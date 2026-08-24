import {
  addNote,
  cancelJob,
  claimJob,
  createJob,
  fetchJobCount,
  fetchJobs,
  fetchMembers,
  fetchProject,
  setProgress,
  transitionJob,
  updateJob,
  ApiError,
} from "./api.js";
import { connectEvents } from "./sse.js";
import {
  el,
  formatDate,
  initials,
  priorityClass,
  priorityPill,
  relativeTime,
  stateBadge,
  toast,
} from "./ui.js";

const JOB_STATES = [
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];
const ACTIVE_STATES = ["IN_PROGRESS", "PAUSED", "BLOCKED"];
const REFRESH_DEBOUNCE_MS = 150;
const EMPTY_GUIDANCE =
  "No work items yet. Create the first one to get started.";

const state = {
  me: null,
  members: [],
  jobs: [],
  nextCursor: null,
  typeFilter: "ALL",
  priorityFilter: "all",
  ageSort: "none",
  pageSize: 25,
  search: "",
  totalCount: null,
  typeCounts: {},
  editingId: null,
  loadingJobs: false,
};

let events = null;

const $ = (id) => document.getElementById(id);

// Wire format opt-in: leading "{" and trailing "}" mark Markdown mode.
const isWrapped = (raw) => {
  const trimmed = String(raw ?? "").trim();
  return (
    trimmed.length >= 2 && trimmed.startsWith("{") && trimmed.endsWith("}")
  );
};
const stripWrapper = (raw) =>
  String(raw ?? "")
    .trim()
    .slice(1, -1)
    .trim();

function setLiveIndicator(open) {
  $("connection-state").classList.toggle("off", !open);
  $("connection-text").textContent = open ? "Live" : "Reconnecting…";
}

async function safeLoad(promise, onError) {
  try {
    return await promise;
  } catch (error) {
    onError(error);
    return null;
  }
}

async function loadProject() {
  const project = await safeLoad(fetchProject(), () =>
    toast("Could not load project identity.", "error"),
  );
  if (!project) return;
  state.me = project.me;
  $("project-name").textContent = project.projectName || "Jobsmith";
  document.title = `${project.projectName || "Jobsmith"} — Jobsmith`;
}

function renderMembers() {
  const list = $("member-list");
  list.replaceChildren();
  const sorted = [...state.members].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const member of sorted) {
    list.append(
      el("li", { class: "member-row" }, [
        el("span", { class: "avatar", text: initials(member.name) }),
        el("span", { class: "member-copy" }, [
          el("span", { class: "member-name" }, [
            el("span", {
              class: `presence${member.online ? "" : " offline"}`,
              title: member.online ? "Online" : "Offline",
            }),
            el("span", { text: member.name }),
          ]),
        ]),
        el("span", {
          class: `role-pill role-${member.role.toLowerCase()}`,
          text: member.role,
        }),
      ]),
    );
  }
  if (!sorted.length)
    list.append(el("li", { class: "team-empty", text: "No members yet." }));
}

async function loadMembers() {
  const members = await safeLoad(fetchMembers(), () =>
    toast("Could not load members.", "error"),
  );
  if (!members) return;
  state.members = members;
  renderMembers();
}

function renderCounts() {
  for (const span of document.querySelectorAll("[data-count-for]")) {
    const key = span.dataset.countFor;
    const value = key === "ALL" ? state.totalCount : state.typeCounts[key];
    span.textContent =
      value === null || value === undefined ? "–" : String(value);
  }
}

async function loadCounts() {
  // Per-state totals come from cheap count queries; failures degrade to a dash.
  const results = await Promise.all([
    safeLoad(fetchJobCount(), () => undefined),
    ...JOB_STATES.map((value) =>
      safeLoad(fetchJobCount(value), () => undefined),
    ),
  ]);
  state.totalCount = results[0]?.total ?? null;
  state.typeCounts = {};
  JOB_STATES.forEach((value, index) => {
    state.typeCounts[value] = results[index + 1]?.total ?? null;
  });
  renderCounts();
}

function canEdit(job) {
  const unclaimedEditable =
    ["PENDING", "READY"].includes(job.state) && job.assignedMemberId === null;
  const mineActive =
    ACTIVE_STATES.includes(job.state) &&
    job.assignedMemberId === state.me?.memberId;
  return unclaimedEditable || mineActive;
}

function canCancel(job) {
  const unclaimedPending =
    job.state === "PENDING" && job.assignedMemberId === null;
  const mineActive =
    ACTIVE_STATES.includes(job.state) &&
    job.assignedMemberId === state.me?.memberId;
  return unclaimedPending || mineActive;
}

function canUpdate(job) {
  return (
    ACTIVE_STATES.includes(job.state) &&
    job.assignedMemberId === state.me?.memberId
  );
}

function canClaim(job) {
  return (
    ["PENDING", "READY"].includes(job.state) &&
    job.assignedMemberId === null &&
    state.me !== null
  );
}

function closeOpenMenus(except = null) {
  for (const menu of document.querySelectorAll(".menu.open, .row-menu.open")) {
    if (menu !== except) menu.classList.remove("open");
  }
}

document.addEventListener("click", () => closeOpenMenus());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOpenMenus();
});

async function runRowAction(button, action, { confirmClose = null } = {}) {
  button.disabled = true;
  try {
    await action();
    confirmClose?.close();
    // Refresh arrives via the SSE change event when connected.
    if (!events?.connected) scheduleRefresh();
  } catch (error) {
    confirmClose?.close();
    toast(
      error instanceof ApiError ? error.message : "Something went wrong.",
      "error",
    );
  } finally {
    button.disabled = false;
  }
}

function kebabMenu(job) {
  const items = [];
  if (canEdit(job))
    items.push({ label: "Edit job", action: () => openEditDialog(job) });
  if (canCancel(job))
    items.push({
      label: "Cancel job",
      danger: true,
      action: () => openCancelConfirm(job),
    });
  if (!items.length) return [];
  const menu = el("div", { class: "row-menu" }, [
    ...items.map((item) =>
      el("button", {
        type: "button",
        class: item.danger ? "danger" : undefined,
        text: item.label,
        onclick: (event) => {
          event.stopPropagation();
          menu.classList.remove("open");
          item.action();
        },
      }),
    ),
  ]);
  const trigger = el("button", {
    type: "button",
    class: "more",
    title: "More actions",
    "aria-label": "More actions",
    "aria-haspopup": "true",
    text: "•••",
    onclick: (event) => {
      event.stopPropagation();
      const opening = !menu.classList.contains("open");
      closeOpenMenus(menu);
      menu.classList.toggle("open", opening);
    },
  });
  return [trigger, menu];
}

function actionsCell(job) {
  const actions = el("div", { class: "actions" });
  if (canUpdate(job))
    actions.append(
      el("button", {
        type: "button",
        class: "action-update",
        text: "Update",
        onclick: (event) => {
          event.stopPropagation();
          openUpdateDialog(job);
        },
      }),
    );
  else if (canClaim(job))
    actions.append(
      el("button", {
        type: "button",
        class: "claim",
        text: "Claim",
        onclick: (event) => {
          event.stopPropagation();
          runRowAction(event.currentTarget, () => claimJob(job.id));
        },
      }),
    );
  actions.append(...kebabMenu(job));
  return el("td", { onclick: (event) => event.stopPropagation() }, [actions]);
}

function jobRow(job) {
  const row = el("tr", { tabindex: "0" }, [
    el("td", {}, [
      el("div", { class: "job-title", text: job.title }),
      ...(job.tags?.length
        ? [
            el(
              "div",
              { class: "tags" },
              job.tags
                .slice(0, 3)
                .map((tag) => el("span", { class: "tag", text: tag })),
            ),
          ]
        : []),
    ]),
    el("td", {}, [stateBadge(job.state)]),
    el("td", {}, [priorityPill(job.priority)]),
    el("td", {
      class: "muted",
      text: job.dueAt ? formatDate(job.dueAt) : "—",
      title: job.dueAt,
    }),
    el("td", {}, [
      job.assignedWorkerName
        ? el("span", { class: "assignee" }, [
            el("span", {
              class: "avatar",
              text: initials(job.assignedWorkerName),
            }),
            el("span", { text: job.assignedWorkerName }),
          ])
        : el("span", { class: "muted", text: "—" }),
    ]),
    el("td", {
      class: "muted",
      text: relativeTime(job.updatedAt),
      title: job.updatedAt,
    }),
    actionsCell(job),
  ]);
  row.addEventListener("click", () => openDetails(job));
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openDetails(job);
  });
  return row;
}

function applyAgeSort(jobs) {
  const indexed = jobs.map((job, index) => ({ job, index }));
  if (state.ageSort === "none") return indexed.map((entry) => entry.job);
  const direction = state.ageSort === "oldest" ? 1 : -1;
  indexed.sort((a, b) => {
    const left = String(a.job.createdAt ?? "");
    const right = String(b.job.createdAt ?? "");
    // ISO strings order lexicographically; ties fall back to loaded order.
    return direction * ((left > right) - (left < right) || a.index - b.index);
  });
  return indexed.map((entry) => entry.job);
}

function renderJobs() {
  const body = $("jobs-body");
  const empty = $("jobs-empty");
  const more = $("load-more");

  $("jobs-skeleton").classList.add("hidden");
  $("jobs-table-wrap").hidden = false;

  const ordered = applyAgeSort(state.jobs);
  const query = state.search.trim().toLowerCase();
  const visible = ordered.filter(
    (job) =>
      (state.priorityFilter === "all" ||
        priorityClass(job.priority) === state.priorityFilter) &&
      (!query || job.title.toLowerCase().includes(query)),
  );

  if (!visible.length) {
    body.replaceChildren();
    empty.textContent = state.jobs.length
      ? "No jobs match the current filters."
      : EMPTY_GUIDANCE;
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    body.replaceChildren(...visible.map((job) => jobRow(job)));
  }

  $("result-count").textContent =
    `${visible.length} visible ${visible.length === 1 ? "job" : "jobs"}`;
  $("sort-status").textContent =
    state.ageSort === "none"
      ? "No age sort applied"
      : state.ageSort === "oldest"
        ? "Oldest first"
        : "Newest first";

  more.hidden = !state.nextCursor;
  more.disabled = state.loadingJobs;
}

function showJobsError(show) {
  $("jobs-error").classList.toggle("hidden", !show);
  $("jobs-table-wrap").classList.toggle("hidden", show);
}

function showSkeleton(count = 6) {
  $("jobs-skeleton").replaceChildren(
    ...Array.from({ length: count }, () =>
      el("div", { class: "skeleton-row" }, [
        el("span", { class: "skeleton-bar" }),
      ]),
    ),
  );
  $("jobs-skeleton").classList.remove("hidden");
  $("jobs-empty").classList.add("hidden");
  $("jobs-table-wrap").hidden = true;
  $("load-more").hidden = true;
  $("result-count").textContent = "Loading…";
}

async function loadJobsPage({ append }) {
  state.loadingJobs = true;
  $("load-more").disabled = true;
  const query = {
    limit: state.pageSize,
    ...(state.typeFilter === "ALL" ? {} : { state: state.typeFilter }),
    ...(append && state.nextCursor ? { cursor: state.nextCursor } : {}),
  };
  const page = await safeLoad(fetchJobs(query), (error) => {
    showJobsError(true);
    if (!(error instanceof ApiError)) throw error;
  });
  state.loadingJobs = false;
  if (!page) {
    renderJobs();
    return;
  }
  showJobsError(false);
  state.jobs = append ? [...state.jobs, ...page.jobs] : page.jobs;
  state.nextCursor = page.nextCursor;
  renderJobs();
}

async function refreshAll({ withSkeleton = false } = {}) {
  $("refresh-button").disabled = true;
  if (withSkeleton) showSkeleton();
  try {
    await Promise.all([
      loadProject(),
      loadMembers(),
      loadCounts(),
      loadJobsPage({ append: false }),
    ]);
  } finally {
    $("refresh-button").disabled = false;
  }
}

function selectType(value) {
  if (state.typeFilter === value) return;
  state.typeFilter = value;
  state.jobs = [];
  state.nextCursor = null;
  void refreshAll({ withSkeleton: true });
}

const MAX_PAGE_SIZE = 200;

// A new page size restarts pagination: cursors from the old page length
// would produce irregular follow-up pages.
function applyPageSize(size) {
  const next = Math.min(MAX_PAGE_SIZE, Math.max(1, size || state.pageSize));
  $("size-value").textContent = String(next);
  if (next !== state.pageSize) {
    state.pageSize = next;
    state.jobs = [];
    state.nextCursor = null;
    void refreshAll({ withSkeleton: true });
  }
}

function enterCustomPageSize() {
  const holder = $("size-value");
  const input = document.createElement("input");
  // Plain text box: no spinner buttons, numeric keyboards still apply.
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = "3";
  input.className = "size-input";
  input.value = String(state.pageSize);
  input.placeholder = "1-200";
  holder.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const parsed = Number.parseInt(input.value, 10);
    if (
      commit &&
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= MAX_PAGE_SIZE
    ) {
      applyPageSize(parsed);
      holder.textContent = String(state.pageSize);
      return;
    }
    holder.textContent = String(state.pageSize);
    for (const option of document.querySelectorAll('[data-kind="size"]'))
      option.classList.toggle(
        "selected",
        Number(option.dataset.value) === state.pageSize,
      );
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function setupFilterMenus() {
  for (const trigger of document.querySelectorAll(".filter-trigger")) {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = trigger.nextElementSibling;
      const opening = !menu.classList.contains("open");
      closeOpenMenus(menu);
      menu.classList.toggle("open", opening);
    });
  }
  for (const option of document.querySelectorAll(".option")) {
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      const kind = option.dataset.kind;
      const menu = option.closest(".menu");
      for (const other of menu.querySelectorAll(".option"))
        other.classList.remove("selected");
      option.classList.add("selected");
      $(`${kind}-value`).textContent = option.dataset.label;
      menu.classList.remove("open");
      if (kind === "type") selectType(option.dataset.value);
      else if (kind === "priority") {
        state.priorityFilter = option.dataset.value;
        renderJobs();
      } else if (kind === "size") {
        if (option.dataset.value === "custom") enterCustomPageSize();
        else applyPageSize(Number.parseInt(option.dataset.value, 10));
      } else {
        state.ageSort = option.dataset.value;
        renderJobs();
      }
    });
  }
  $("search-input").addEventListener("input", (event) => {
    state.search = event.currentTarget.value;
    renderJobs();
  });
}

let refreshTimer = null;

// SSE is the single source of truth; mutations never reload directly.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void refreshAll();
  }, REFRESH_DEBOUNCE_MS);
}

/* Dialogs */

function openFieldHint(input, hint, message) {
  input.setAttribute("aria-invalid", "true");
  hint.textContent = message;
  hint.hidden = false;
}

function clearFieldHints() {
  for (const [inputId, hintId] of [
    ["job-title", "title-hint"],
    ["job-description", "description-hint"],
    ["job-priority", "priority-hint"],
    ["job-tags", "tags-hint"],
  ]) {
    $(inputId).removeAttribute("aria-invalid");
    $(hintId).hidden = true;
  }
}

function applyValidationHints(details) {
  const targets = {
    title: [$("job-title"), $("title-hint")],
    description: [$("job-description"), $("description-hint")],
    priority: [$("job-priority"), $("priority-hint")],
    tags: [$("job-tags"), $("tags-hint")],
  };
  let matched = false;
  for (const detail of details) {
    const separator = detail.indexOf(":");
    if (separator < 0) continue;
    const field = detail.slice(0, separator).trim().toLowerCase();
    const pair = targets[field];
    if (!pair) continue;
    openFieldHint(pair[0], pair[1], detail.slice(separator + 1).trim());
    matched = true;
  }
  if (!matched) toast(details[0] ?? "Validation failed.", "error");
}

function updateCounters() {
  const titleCount = $("title-count");
  titleCount.textContent = `${$("job-title").value.length}/120`;
  titleCount.classList.toggle("over", $("job-title").value.length >= 120);
  const descriptionCount = $("description-count");
  descriptionCount.textContent = `${$("job-description").value.length}/4000`;
  descriptionCount.classList.toggle(
    "over",
    $("job-description").value.length >= 4000,
  );
}

function parseTagsInput(value) {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// Matches the CLI convention: deadlines are UTC midnight of the picked day.
function dueDateValue() {
  const raw = $("job-due-date").value;
  return raw ? new Date(`${raw}T00:00:00Z`).toISOString() : null;
}

function openCreateDialog() {
  state.editingId = null;
  $("job-dialog-title").textContent = "New job";
  $("job-submit-button").textContent = "Create";
  $("job-form").reset();
  $("job-markdown").checked = false;
  $("job-priority").value = "5";
  $("job-due-date").value = "";
  updateCounters();
  clearFieldHints();
  $("job-dialog").showModal();
}

// Jobs may hold any 0-9 priority from the CLI; editing snaps display to the
// matching label band so the select never shows a blank value.
const PRIORITY_BANDS = [
  { min: 9, value: "9" },
  { min: 7, value: "7" },
  { min: 4, value: "5" },
];

function priorityOptionValue(priority) {
  const band = PRIORITY_BANDS.find((band) => priority >= band.min);
  return band ? band.value : "2";
}

function openEditDialog(job) {
  state.editingId = job.id;
  $("job-dialog-title").textContent = "Edit job";
  $("job-submit-button").textContent = "Save";
  $("job-form").reset();
  $("job-title").value = job.title;
  // Primary signal is the server field; the local fallback keeps editing
  // correct against stale cached rows.
  const markdown = job.descriptionHtml != null || isWrapped(job.description);
  $("job-markdown").checked = markdown;
  $("job-description").value = markdown
    ? stripWrapper(job.description)
    : (job.description ?? "");
  $("job-priority").value = priorityOptionValue(job.priority);
  $("job-due-date").value = job.dueAt ? String(job.dueAt).slice(0, 10) : "";
  $("job-tags").value = (job.tags ?? []).join(", ");
  updateCounters();
  clearFieldHints();
  $("job-dialog").showModal();
}

async function submitJobForm(event) {
  event.preventDefault();
  const button = $("job-submit-button");
  clearFieldHints();
  const description = $("job-description").value;
  const patch = {
    title: $("job-title").value.trim(),
    description: $("job-markdown").checked ? `{${description}}` : description,
    priority: Number.parseInt($("job-priority").value, 10),
    tags: parseTagsInput($("job-tags").value),
    dueAt: dueDateValue(),
  };
  if (!Number.isInteger(patch.priority)) delete patch.priority;
  // An empty ticked box must reuse the existing empty-description path,
  // not silently store "{}".
  if (patch.description === "" || patch.description === "{}")
    delete patch.description;
  button.disabled = true;
  const finish = () => {
    button.disabled = false;
  };
  try {
    if (state.editingId) await updateJob(state.editingId, patch);
    else await createJob(patch);
    $("job-dialog").close();
    // Refresh arrives via the SSE change event when connected.
    if (!events?.connected) scheduleRefresh();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 400 && error.details.length)
        applyValidationHints(error.details);
      else toast(error.message, "error");
    } else {
      toast("Something went wrong.", "error");
    }
  } finally {
    finish();
  }
}

let pendingCancelId = null;

function openCancelConfirm(job) {
  pendingCancelId = job.id;
  $("cancel-job-text").textContent =
    `"${job.title}" will be marked as cancelled.`;
  $("cancel-job-dialog").showModal();
}

async function confirmCancel() {
  if (!pendingCancelId) return;
  const id = pendingCancelId;
  pendingCancelId = null;
  const button = $("cancel-job-yes");
  button.disabled = true;
  try {
    await cancelJob(id);
    $("cancel-job-dialog").close();
    if (!events?.connected) scheduleRefresh();
  } catch (error) {
    $("cancel-job-dialog").close();
    toast(
      error instanceof ApiError ? error.message : "Something went wrong.",
      "error",
    );
  } finally {
    button.disabled = false;
  }
}

let updateTarget = null;

function openUpdateDialog(job) {
  updateTarget = job;
  $("update-dialog-title").textContent = "Update job";
  $("update-job-title").textContent = job.title;
  $("update-progress").value = String(job.progressPercent ?? 0);
  $("progress-hint").hidden = true;
  $("update-note").value = "";
  $("update-dialog").showModal();
}

async function submitUpdate(event) {
  event.preventDefault();
  if (!updateTarget) return;
  const button = $("update-save-button");
  const id = updateTarget.id;
  const progress = Number.parseInt($("update-progress").value, 10);
  const note = $("update-note").value.trim();
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    $("progress-hint").textContent = "Enter a number between 0 and 100.";
    $("progress-hint").hidden = false;
    return;
  }
  button.disabled = true;
  try {
    await setProgress(id, progress);
    if (note) await addNote(id, note);
    $("update-dialog").close();
    if (!events?.connected) scheduleRefresh();
  } catch (error) {
    toast(
      error instanceof ApiError ? error.message : "Something went wrong.",
      "error",
    );
  } finally {
    button.disabled = false;
  }
}

async function applyTransition(outcome) {
  if (!updateTarget) return;
  const id = updateTarget.id;
  let message;
  if (outcome === "BLOCKED")
    message = window.prompt("What is blocking this job?") || undefined;
  if (outcome === "FAILED")
    message = window.prompt("Why did this job fail?") || undefined;
  await transitionJob(id, outcome, message);
}

function detailEntry(label, value) {
  return [
    el("dt", { text: label }),
    el("dd", {}, typeof value === "string" ? [value] : value ? [value] : []),
  ];
}

function openDetails(job) {
  $("details-title").textContent = job.title;
  const entries = [
    ...detailEntry("State", stateBadge(job.state)),
    ...detailEntry("Priority", priorityPill(job.priority)),
    ...detailEntry("Progress", `${job.progressPercent ?? 0}%`),
    ...detailEntry("Assigned", job.assignedWorkerName || "—"),
    ...detailEntry(
      "Tags",
      job.tags?.length
        ? el(
            "span",
            { class: "tags" },
            job.tags.map((tag) => el("span", { class: "tag", text: tag })),
          )
        : null,
    ),
    ...detailEntry("Created", relativeTime(job.createdAt)),
    ...detailEntry("Updated", relativeTime(job.updatedAt)),
    ...(job.dueAt ? detailEntry("Due", formatDate(job.dueAt)) : []),
    ...(job.blockedReason
      ? detailEntry("Blocked reason", job.blockedReason)
      : []),
    ...(job.claimedUntil
      ? detailEntry("Claimed until", relativeTime(job.claimedUntil))
      : []),
  ];
  $("details-grid").replaceChildren(...entries.flat());
  const description = $("details-description");
  if (job.descriptionHtml) {
    // The server already sanitized this HTML; the client never parses
    // Markdown itself.
    console.debug("[jobsmith] markdown description", job.id);
    description.replaceChildren(
      el("div", { class: "md-body", html: job.descriptionHtml }),
    );
    description.classList.remove("muted");
  } else {
    console.debug("[jobsmith] plain description", job.id);
    description.textContent = job.description || "No description.";
    description.classList.toggle("muted", !job.description);
  }
  $("details-dialog").showModal();
}

function start() {
  setupFilterMenus();

  // Clicking the backdrop (the dialog element itself) closes any popup.
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  $("create-button").addEventListener("click", openCreateDialog);
  $("refresh-button").addEventListener("click", () => {
    void refreshAll({ withSkeleton: true });
  });

  $("job-form").addEventListener("submit", submitJobForm);
  $("job-cancel-button").addEventListener("click", () =>
    $("job-dialog").close(),
  );
  $("job-title").addEventListener("input", updateCounters);
  $("job-description").addEventListener("input", updateCounters);

  $("retry-button").addEventListener(
    "click",
    () => void refreshAll({ withSkeleton: true }),
  );
  $("load-more").addEventListener(
    "click",
    () => void loadJobsPage({ append: true }),
  );

  $("cancel-job-yes").addEventListener("click", () => void confirmCancel());
  $("cancel-job-no").addEventListener("click", () =>
    $("cancel-job-dialog").close(),
  );

  $("update-form").addEventListener(
    "submit",
    (event) => void submitUpdate(event),
  );
  $("update-close-button").addEventListener("click", () =>
    $("update-dialog").close(),
  );
  for (const button of document.querySelectorAll(
    "#update-dialog [data-outcome]",
  )) {
    button.addEventListener("click", () => {
      button.disabled = true;
      runRowAction(button, () =>
        applyTransition(button.dataset.outcome),
      ).finally(() => {
        button.disabled = false;
      });
    });
  }

  $("details-close-button").addEventListener("click", () =>
    $("details-dialog").close(),
  );

  events = connectEvents({
    onStateChange: setLiveIndicator,
    onChange: scheduleRefresh,
    onVisible: () => void refreshAll(),
  });

  void refreshAll({ withSkeleton: true });
}

start();
