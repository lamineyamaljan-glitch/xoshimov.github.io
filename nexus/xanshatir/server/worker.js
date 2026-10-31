/* Xan Shatir — order server for Cloudflare Workers (free plan).

   Takes orders from the table menu (NFC card on a table) and from the delivery site, keeps them
   in a KV namespace bound as XAN, and sends each one to the restaurant's Telegram.
   Secrets live in Cloudflare, never in this file:
     BOT_TOKEN  — token from @BotFather
     ADMIN_PIN  — PIN for the sales panel and for linking Telegram (defaults to 1234)

   Storage: "open"  = orders not yet paid or cancelled, waiter calls, orders closed in the last day (small, read on every poll)
            "sales:YYYY-MM" = paid orders of that month (read when the panel opens)
   Personal data: a delivery order is taken only with the customer's consent; their name, phone and address are kept
   only while the order is open (24 hours at most) and are dropped once it is paid or cancelled.

   Routes
     GET    /                    health check
     POST   /order               new order {id, table} from a table, or {id, delivery:{name, phone, address, comment, pay}}
     POST   /waiter              call the waiter to a table {id, table}
     GET    /live                open orders, waiter calls, recently closed   (PIN)
     PATCH  /orders/:id          status {s: accepted | onway | paid | cancel}  (PIN)
     DELETE /calls/:id           waiter came                                   (PIN)
     GET    /sales?months=2      paid orders of the last months                (PIN)
     GET    /pack                which dishes go with disposable dishes in delivery {"Dish name": true|false}
     PUT    /pack                save that list                                (PIN)
     GET    /init?pin=…          connect the bot (sets the webhook) and show the link to subscribe
     POST   /tg                  Telegram webhook ("/start <PIN>" subscribes a chat)
*/

const MAX_OPEN = 150, OPEN_HOURS = 24, CALL_GAP = 30e3;
const PAYS = { cash: 'Наличными курьеру', card: 'Картой/переводом курьеру', click: 'Click', payme: 'Payme' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Pin',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const pinOf = env => String(env.ADMIN_PIN || '1234');
const authed = (req, env) => req.headers.get('X-Pin') === pinOf(env);
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const money = n => Math.round(+n || 0).toLocaleString('ru-RU').replace(/ |,/g, ' ') + ' сум';
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const okId = id => /^[a-z0-9]{6,24}$/.test(String(id));
// what stays of a delivery order after it is closed: no name, phone, address or comment
const anonymous = o => o.delivery ? { ...o, delivery: { pay: o.delivery.pay } } : o;
const monthOf = t => new Date(t + 5 * 36e5).toISOString().slice(0, 7);   // Tashkent time, UTC+5
// Telegram only accepts A-Z a-z 0-9 _ - in the webhook secret
const hookSecret = env => String(env.BOT_TOKEN || '').split(':')[1]?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'none';

async function getJSON(env, key, fallback){ return (await env.XAN.get(key, 'json')) ?? fallback; }
// KV takes one write per second per key; a busy minute retries instead of losing the order
async function putJSON(env, key, value){
  for (let i = 0; ; i++){
    try { return await env.XAN.put(key, JSON.stringify(value)); }
    catch (e){ if (i >= 3) throw e; await new Promise(r => setTimeout(r, 1100)); }
  }
}
async function getOpen(env){
  const o = await getJSON(env, 'open', {});
  const old = Date.now() - OPEN_HOURS * 36e5, keep = x => x.t > old;
  o.orders = (o.orders || []).filter(keep); o.calls = (o.calls || []).filter(keep); o.closed = (o.closed || []).filter(keep);   // closed: recently paid or cancelled, so every open panel hears about it
  return o;
}

async function tg(env, method, body){
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is not set' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, description: 'Telegram is unreachable: ' + e.message }; }
}
// a Telegram hiccup must never lose an order, so failures here are swallowed
async function notify(env, text){
  try {
    const chats = await getJSON(env, 'chats', []);
    await Promise.all(chats.map(chat_id => tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null)));
  } catch (e) {}
}
function orderText(o){
  const d = o.delivery;
  return [d ? '🛵 <b>Доставка</b>' : `🍽 <b>Стол №${esc(o.table)}</b>`,
    ...(d ? [`👤 ${esc(d.name)}, ${esc(d.phone)}`, `📍 ${esc(d.address)}`] : []),
    ...o.items.map(([n, q, p]) => `• ${esc(n)} × ${q} — ${money(p * q)}`),
    `💰 <b>Итого: ${money(o.sum)}</b>${d ? ' · ' + esc(PAYS[d.pay] || d.pay) : ''}`,
    d && d.comment ? `💬 ${esc(d.comment)}` : ''].filter(Boolean).join('\n');
}

function cleanOrder(b){
  if (!okId(b.id)) throw new Error('bad id');
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map(i => [str(i[0], 80), Math.max(1, Math.min(50, Math.round(+i[1]) || 1)), Math.max(0, Math.min(1e7, Math.round(+i[2]) || 0))]).filter(i => i[0]);
  if (!items.length) throw new Error('empty order');
  const o = { id: b.id, items, sum: items.reduce((s, [, q, p]) => s + q * p, 0), t: Date.now(), s: 'new' };
  if (b.delivery){
    const d = b.delivery;
    o.delivery = { name: str(d.name, 60), phone: str(d.phone, 30), address: str(d.address, 200), comment: str(d.comment, 300), pay: str(d.pay, 10) };
    if (!o.delivery.name || o.delivery.phone.replace(/\D/g, '').length < 9 || o.delivery.address.length < 3) throw new Error('name, phone and address are required');
    if (d.agreed !== true) throw new Error('consent to the offer and to personal data processing is required');
    o.delivery.agreedAt = Date.now();
  } else {
    o.table = str(b.table, 4).replace(/\D/g, '') || '?';
  }
  return o;
}

export default {
  async fetch(req, env, ctx){
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/', M = req.method;
    try {
      if (path === '/' && M === 'GET') return json({ ok: true, service: 'xan-orders', telegram: !!env.BOT_TOKEN, chats: (await getJSON(env, 'chats', [])).length });

      if (path === '/order' && M === 'POST'){
        const o = cleanOrder(await req.json()), open = await getOpen(env);
        if (open.orders.some(x => x.id === o.id)) return json(o);   // a resent order is not doubled
        if (open.orders.length >= MAX_OPEN) return fail('too many open orders', 429);
        open.orders.push(o); await putJSON(env, 'open', open);
        ctx.waitUntil(notify(env, orderText(o)));
        return json(o, 201);
      }
      if (path === '/waiter' && M === 'POST'){
        const b = await req.json(), table = str(b.table, 4).replace(/\D/g, '');
        if (!okId(b.id) || !table) return fail('bad request');
        const open = await getOpen(env);
        if (open.calls.some(c => c.table === table && Date.now() - c.t < CALL_GAP)) return json({ ok: true });
        open.calls.push({ id: b.id, table, t: Date.now() }); await putJSON(env, 'open', open);
        ctx.waitUntil(notify(env, `🔔 <b>Стол №${esc(table)}</b> зовёт официанта`));
        return json({ ok: true }, 201);
      }


      if (path === '/init' && M === 'GET'){
        if (url.searchParams.get('pin') !== pinOf(env)) return fail('add ?pin=YOUR_PIN to the link', 401);
        const hook = await tg(env, 'setWebhook', { url: `${url.origin}/tg`, secret_token: hookSecret(env), allowed_updates: ['message'] });
        const me = await tg(env, 'getMe', {});
        const link = me.ok ? `https://t.me/${me.result.username}?start=${encodeURIComponent(pinOf(env))}` : null;
        return json({ webhook: hook.ok ? 'connected' : hook.description, bot: me.ok ? '@' + me.result.username : me.description,
          next_step: link ? `Open ${link} in Telegram and press Start — orders will come to that chat. Every waiter can do the same.` : 'Check BOT_TOKEN in the Worker settings.' });
      }
      if (path === '/tg' && M === 'POST'){
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== hookSecret(env)) return fail('forbidden', 403);
        const u = await req.json(); const msg = u.message; if (!msg || !msg.text) return json({ ok: true });
        const chat = msg.chat.id, [cmd, arg] = msg.text.trim().split(/\s+/);
        if (cmd === '/start' || cmd === '/stop'){
          let chats = await getJSON(env, 'chats', []);
          if (cmd === '/stop'){ chats = chats.filter(c => c !== chat); await putJSON(env, 'chats', chats); await tg(env, 'sendMessage', { chat_id: chat, text: 'Уведомления о заказах отключены.' }); }
          else if (arg === pinOf(env)){ if (!chats.includes(chat)) chats.push(chat); await putJSON(env, 'chats', chats); await tg(env, 'sendMessage', { chat_id: chat, text: '✅ Готово! Заказы Xan Shatir со столов и доставки будут приходить сюда.\nОтключить: /stop' }); }
          else await tg(env, 'sendMessage', { chat_id: chat, text: 'Это бот заказов Xan Shatir. Чтобы получать заказы, откройте ссылку подключения от владельца.' });
        }
        return json({ ok: true });
      }

      if (path === '/pack' && M === 'GET') return json(await getJSON(env, 'pack', {}));

      // the sales panel
      const panel = path === '/live' || path === '/sales' || path === '/pack' || /^\/(orders|calls)\//.test(path);
      if (panel && !authed(req, env)) return fail('wrong PIN', 401);
      if (path === '/live' && M === 'GET') return json(await getOpen(env));
      if (path === '/sales' && M === 'GET'){
        const n = Math.max(1, Math.min(12, +url.searchParams.get('months') || 2)), out = [];
        for (let i = n - 1; i >= 0; i--){ const d = new Date(Date.now() + 5 * 36e5); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); out.push(...await getJSON(env, 'sales:' + d.toISOString().slice(0, 7), [])); }
        return json(out);
      }
      if (path === '/pack' && M === 'PUT'){
        const b = await req.json(), pack = {};
        for (const [k, v] of Object.entries(b && typeof b === 'object' ? b : {}).slice(0, 300)) if (str(k, 100)) pack[str(k, 100)] = !!v;
        await putJSON(env, 'pack', pack);
        return json(pack);
      }
      let m = path.match(/^\/orders\/([a-z0-9]+)$/);
      if (m && M === 'PATCH'){
        const { s } = await req.json(); if (!['accepted', 'onway', 'paid', 'cancel'].includes(s)) return fail('unknown status');
        const open = await getOpen(env), o = open.orders.find(x => x.id === m[1]);
        if (!o) return fail('order not found', 404);
        if (s === 'paid' || s === 'cancel'){
          open.orders = open.orders.filter(x => x !== o); open.closed.push({ id: o.id, s, t: Date.now() });
          if (s === 'paid'){ const key = 'sales:' + monthOf(o.t), sales = await getJSON(env, key, []); sales.push({ ...o, s: 'paid', paidAt: Date.now() }); await putJSON(env, key, sales.map(anonymous)); }
        } else o.s = s;
        await putJSON(env, 'open', open);
        return json({ ...o, s });
      }
      m = path.match(/^\/calls\/([a-z0-9]+)$/);
      if (m && M === 'DELETE'){
        const open = await getOpen(env); open.calls = open.calls.filter(c => c.id !== m[1]); await putJSON(env, 'open', open);
        return json({ ok: true });
      }
      return fail('not found', 404);
    } catch (e){
      return fail(e.message || 'server error', 400);
    }
  }
};
