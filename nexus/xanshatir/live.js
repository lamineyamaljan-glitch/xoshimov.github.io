/* Link between the table menu, the delivery site and the sales panel.
   API set   = the restaurant's order server (server/worker.js on Cloudflare): orders are kept,
               arrive in Telegram, and the panel needs the owner's PIN.
   API empty = demo channel through ntfy.sh (public pub/sub, no account, keeps messages ~12 hours),
               good only for showing the flow.
   Message kinds: {k:"order", id, table | delivery:{name, phone, address, comment, pay}, items:[[nameRu, qty, price]], sum}
                  {k:"waiter", id, table}
                  {k:"status", id, s:"accepted"|"onway"|"paid"|"cancel"|"done"} */
const LIVE = {
  API: "https://xan-orders.lamineyamaljan.workers.dev",
  url: "https://ntfy.sh/nexus-xanshatir-afb4baf69d5b",
  id: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  pin: (() => { try { return sessionStorage.getItem("xs_pin") || ""; } catch (e) { return ""; } })(),

  async call(path, { method = "GET", body } = {}){
    const r = await fetch(LIVE.API.replace(/\/$/, "") + path, { method, headers: { "Content-Type": "application/json", ...(LIVE.pin ? { "X-Pin": LIVE.pin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error((data && data.error) || "HTTP " + r.status), { status: r.status });
    return data;
  },

  // which dishes go with disposable dishes in delivery (see needsPack in menu.js); the demo channel keeps no settings
  pack: () => LIVE.API ? LIVE.call("/pack") : Promise.resolve({}),
  savePack: set => LIVE.call("/pack", { method: "PUT", body: set }),

  async send(data){
    if (!LIVE.API){
      const r = await fetch(LIVE.url, { method: "POST", body: JSON.stringify(data) });
      if (!r.ok) throw new Error("ntfy " + r.status);
      return;
    }
    if (data.k === "order") return LIVE.call("/order", { method: "POST", body: data });
    if (data.k === "waiter") return LIVE.call("/waiter", { method: "POST", body: data });
    if (data.k === "status") return data.s === "done" ? LIVE.call("/calls/" + data.id, { method: "DELETE" })
      : LIVE.call("/orders/" + data.id, { method: "PATCH", body: { s: data.s } });
  },

  // onData(message, timeMs) for every message, older history first; onState(connected); onAuth() when the PIN is wrong
  listen(onData, onState, onAuth){
    if (!LIVE.API){
      const seen = new Set();   // EventSource reconnects replay the history, skip what we already have
      const es = new EventSource(LIVE.url + "/sse?since=12h");
      es.onopen = () => onState(true);
      es.onerror = () => onState(false);
      es.onmessage = e => {
        try {
          const m = JSON.parse(e.data);
          if (m.event !== "message" || seen.has(m.id)) return;
          seen.add(m.id);
          onData(JSON.parse(m.message), m.time * 1000);
        } catch (err) {}
      };
      return;
    }
    // server: paid orders of the last two months once, then the open orders every few seconds
    const orders = new Map(), calls = new Set();
    const fail = e => { onState(false); if (e.status === 401 && onAuth) { stop = true; onAuth(); } };
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const live = await LIVE.call("/live");
        for (const o of live.orders){
          if (!orders.has(o.id)) onData({ k: "order", ...o, s: undefined }, o.t);
          if (orders.get(o.id) !== o.s && o.s !== "new") onData({ k: "status", id: o.id, s: o.s }, Date.now());
          orders.set(o.id, o.s);
        }
        for (const c of live.calls) if (!calls.has(c.id)) { calls.add(c.id); onData({ k: "waiter", ...c }, c.t); }
        const gone = new Map((live.closed || []).map(x => [x.id, x.s]));
        for (const id of orders.keys()) if (!live.orders.some(o => o.id === id)) { onData({ k: "status", id, s: gone.get(id) || "cancel" }, Date.now()); orders.delete(id); }
        for (const id of [...calls]) if (!live.calls.some(c => c.id === id)) { onData({ k: "status", id, s: "done" }, Date.now()); calls.delete(id); }
        onState(true);
      } catch (e) { fail(e); }
      if (!stop) setTimeout(tick, 3000);
    };
    LIVE.call("/sales?months=2").then(list => {
      for (const o of list){ onData({ k: "order", ...o, s: undefined }, o.t); onData({ k: "status", id: o.id, s: "paid" }, o.paidAt || o.t); }
      tick();
    }).catch(e => { fail(e); if (!stop) setTimeout(tick, 3000); });
  }
};
