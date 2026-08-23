// Tiny DOM helpers shared by the dashboard.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function relativeTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Deadlines render as absolute dates, matching the CLI's DD-MM-YYYY style.
export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

export function initials(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

// Bands mirror the CLI so every surface labels priorities the same way.
export function priorityLabel(priority) {
  if (priority >= 9) return "Critical";
  if (priority >= 7) return "High";
  if (priority >= 4) return "Medium";
  return "Low";
}

export function priorityClass(priority) {
  if (priority >= 9) return "critical";
  if (priority >= 7) return "high";
  if (priority >= 4) return "medium";
  return "low";
}

export function stateBadge(state) {
  return el("span", {
    class: `status ${state.toLowerCase()}`,
    text: state.replaceAll("_", " "),
  });
}

export function priorityPill(priority) {
  return el("span", {
    class: `priority ${priorityClass(priority)}`,
    text: priorityLabel(priority),
  });
}

let toastRegion = null;

function ensureToastRegion() {
  if (!toastRegion) {
    toastRegion = el("div", {
      class: "toast-region",
      role: "status",
      "aria-live": "polite",
    });
    document.body.append(toastRegion);
  }
  return toastRegion;
}

export function toast(message, kind = "info") {
  const region = ensureToastRegion();
  const item = el(
    "div",
    { class: `toast${kind === "error" ? " toast-error" : ""}` },
    message,
  );
  region.append(item);
  setTimeout(() => {
    item.classList.add("toast-leaving");
    setTimeout(() => item.remove(), 160);
  }, 4000);
}
