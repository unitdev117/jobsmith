// EventSource wrapper; native auto-reconnect is left untouched.
export function connectEvents(handlers = {}) {
  const source = new EventSource("/api/events");
  const state = { open: false };

  const setOpen = (open) => {
    if (state.open !== open) {
      state.open = open;
      handlers.onStateChange?.(open);
    }
  };

  source.addEventListener("ready", (event) => {
    setOpen(true);
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {}
    handlers.onReady?.(payload ?? { projectId: null });
  });

  source.addEventListener("change", (event) => {
    setOpen(true);
    let envelope = null;
    try {
      envelope = JSON.parse(event.data);
    } catch {}
    if (envelope) handlers.onChange?.(envelope);
  });

  source.onopen = () => setOpen(true);
  source.onerror = () => setOpen(false);

  // Backgrounded tabs miss frames; refresh when the tab returns.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.open) handlers.onVisible?.();
  });

  return {
    get connected() {
      return state.open;
    },
    close() {
      source.close();
      setOpen(false);
    },
  };
}
