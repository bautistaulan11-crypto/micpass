// MicPass server: serves /public and relays room state over WebSocket.
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000, PUB = __dirname, ALLOWED = ["host.html", "join.html", "style.css"];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const u = new URL(req.url, "http://x"); res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/api/status") return res.end(JSON.stringify({ ready: lib.ready, count: lib.count, err: lib.err }));
    if (u.pathname === "/api/search") {
      const toks = (u.searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean), out = [];
      if (toks.length) for (const it of lib.items) if (toks.every(t => it.s.includes(t))) { out.push({ id: it.id, title: it.title }); if (out.length >= 30) break; }
      return res.end(JSON.stringify(out));
    }
    res.statusCode = 404; return res.end("{}");
  }
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/host.html";
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB) || !ALLOWED.includes(path.basename(f))) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": (TYPES[path.extname(f)] || "text/plain") + "; charset=utf-8" });
    res.end(d);
  });
});

// ---------- Song library: read MIDI files straight out of a zip in cloud storage ----------
const zlib = require("zlib");
const ZIP_URL = process.env.ZIP_URL || (process.env.GDRIVE_FILE_ID &&
  `https://www.googleapis.com/drive/v3/files/${process.env.GDRIVE_FILE_ID}?alt=media&key=${process.env.GDRIVE_API_KEY}`);
let lib = { ready: false, count: 0, items: [], err: "" };
const cache = new Map();

async function rget(a, b) {
  const r = await fetch(ZIP_URL, { headers: { Range: `bytes=${a}-${b}` } });
  if (r.status !== 206) { if (r.body) r.body.cancel(); throw new Error("Range request failed (" + r.status + ")"); }
  return Buffer.from(await r.arrayBuffer());
}
async function loadIndex() {
  const r0 = await fetch(ZIP_URL, { headers: { Range: "bytes=0-0" } });
  if (r0.status !== 206) { if (r0.body) r0.body.cancel(); throw new Error("Storage didn't allow partial reads (status " + r0.status + ")"); }
  const size = +r0.headers.get("content-range").split("/")[1]; await r0.arrayBuffer();
  const tailLen = Math.min(size, 66000), tail = await rget(size - tailLen, size - 1);
  const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (e < 0) throw new Error("Not a zip file");
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error("Zip64 zips aren't supported");
  const cd = await rget(cdOff, cdOff + cdSize - 1), items = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
    const full = cd.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (!/\.(mid|midi|kar)$/i.test(full) || /(^|\/)(__MACOSX|\._)/.test(full) || !csize) continue;
    const title = full.split("/").pop().replace(/\.[^.]+$/, "").replace(/_/g, " ");
    items.push({ id: items.length, title, method, csize, off, s: (title + " " + full).toLowerCase() });
  }
  lib = { ready: true, count: items.length, items, err: "" };
  console.log("Library ready:", items.length, "songs");
}
async function getMidiBytes(it) {
  if (cache.has(it.id)) return cache.get(it.id);
  const h = await rget(it.off, it.off + 29), start = it.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = await rget(start, start + it.csize - 1);
  const out = it.method === 0 ? raw : zlib.inflateRawSync(raw);
  cache.set(it.id, out); if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}
function parseMidi(b) {
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), d = new DataView(buf);
  let p = 0; const u32 = () => { const v = d.getUint32(p); p += 4; return v }, u16 = () => { const v = d.getUint16(p); p += 2; return v };
  if (u32() !== 0x4d546864) throw new Error("bad midi"); u32(); u16(); const n = u16(), div = u16(); if (div & 0x8000) throw new Error("bad timing");
  const ev = [], tempos = [[0, 500000]];
  for (let t = 0; t < n; t++) {
    if (u32() !== 0x4d54726b) throw new Error("bad track"); const len = u32(), end = p + len; let tick = 0, run = 0;
    const vl = () => { let v = 0, c; do { c = d.getUint8(p++); v = (v << 7) | (c & 127) } while (c & 128); return v };
    while (p < end) {
      tick += vl(); let s = d.getUint8(p); if (s < 128) s = run; else p++;
      if (s === 0xff) { const ty = d.getUint8(p++), l = vl();
        if (ty === 0x51) tempos.push([tick, (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2)]);
        else if (ty === 1 || ty === 5) ev.push({ tick, tx: Buffer.from(buf, p, l).toString("latin1"), ty });
        p += l; }
      else if (s === 0xf0 || s === 0xf7) p += vl();
      else { run = s; const h = s >> 4, ch = s & 15, a = d.getUint8(p++), c = (h === 0xc || h === 0xd) ? 0 : d.getUint8(p++); if (h === 9 && c > 0 && ch !== 9) ev.push({ tick, note: a }); }
    }
    p = end;
  }
  tempos.sort((x, y) => x[0] - y[0]);
  const sec = k => { let t = 0, last = 0, tp = 500000; for (const [tk, v] of tempos) { if (tk >= k) break; t += (tk - last) * tp / div / 1e6; last = tk; tp = v } return t + (k - last) * tp / div / 1e6 };
  const r2 = x => Math.round(x * 100) / 100;
  const notes = ev.filter(e => e.note !== undefined).slice(0, 8000).map(e => ({ s: r2(sec(e.tick)), n: e.note }));
  let ly = ev.filter(e => e.ty === 5); if (!ly.length) ly = ev.filter(e => e.ty === 1 && e.tx[0] !== "@");
  return { notes, lyr: ly.slice(0, 4000).map(e => ({ s: r2(sec(e.tick)), tx: e.tx })) };
}
if (ZIP_URL) loadIndex().catch(e => { lib.err = e.message; console.error("Library error:", e.message); });
else lib.err = "No library configured";

const rooms = new Map();
let nextId = 1;
const newCode = () => {
  let c;
  do c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join("");
  while (rooms.has(c));
  return c;
};
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function broadcast(r) {
  const base = {
    t: "state", now: r.queue[0] ? r.queue[0].id : null, board: r.board,
    queue: r.queue.map(({ id, title, by, yt, hasMidi }) => ({ id, title, by, yt, hasMidi })),
  };
  for (const ws of r.clients)
    send(ws, ws === r.host ? { ...base, midi: r.queue[0] ? r.queue[0].midi || null : null } : base);
}

function finishSong(r, id, scored) {
  const s = r.queue[0];
  if (!s || s.id !== id) return; // ignore double-taps and stale requests
  r.queue.shift();
  if (scored) {
    const score = 80 + Math.floor(Math.random() * 21); // 80-100
    r.board.push({ title: s.title, by: s.by, score });
    r.board.sort((a, b) => b.score - a.score);
    r.board = r.board.slice(0, 5);
    for (const ws of r.clients) send(ws, { t: "scored", score, title: s.title, by: s.by });
  }
  broadcast(r);
}

const validMidi = m => m && Array.isArray(m.notes) && Array.isArray(m.lyr) && m.notes.length <= 8000 && m.lyr.length <= 4000;

const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 });
wss.on("connection", ws => {
  let room = null, name = "Guest";
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "create") {
      const code = newCode();
      room = { code, host: ws, clients: new Set([ws]), queue: [], board: [] };
      rooms.set(code, room);
      send(ws, { t: "created", code });
      return broadcast(room);
    }
    if (m.t === "join") {
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return send(ws, { t: "error", msg: "Room not found" });
      room = r; name = String(m.name || "Guest").slice(0, 24) || "Guest";
      r.clients.add(ws);
      send(ws, { t: "joined", code: r.code });
      return broadcast(r);
    }
    if (!room) return;
    if (m.t === "add") {
      if (room.queue.length >= 50) return send(ws, { t: "error", msg: "Queue is full" });
      const yt = /^[\w-]{11}$/.test(m.yt || "") ? m.yt : "";
      const midi = validMidi(m.midi) ? { notes: m.midi.notes, lyr: m.midi.lyr } : null;
      const title = String(m.title || "").trim().slice(0, 80) || (yt ? "YouTube karaoke" : midi ? "MIDI song" : "");
      if (!title) return;
      room.queue.push({ id: nextId++, title, by: name, yt, midi, hasMidi: !!midi });
      return broadcast(room);
    }
    if (m.t === "addlib") {
      const it = lib.items[+m.id];
      if (!it || room.queue.length >= 50) return;
      const r = room;
      return getMidiBytes(it).then(b => {
        r.queue.push({ id: nextId++, title: it.title.slice(0, 80), by: name, yt: "", midi: parseMidi(b), hasMidi: true });
        broadcast(r);
      }).catch(() => send(ws, { t: "error", msg: "Couldn't load that song" }));
    }
    if (m.t === "finish") return finishSong(room, m.id, true);
    if (m.t === "skip") return finishSong(room, m.id, false);
    if (m.t === "remove") {
      room.queue = room.queue.filter(s => s.id !== m.id);
      return broadcast(room);
    }
  });
  ws.on("close", () => {
    if (!room) return;
    room.clients.delete(ws);
    if (ws === room.host) { for (const c of room.clients) c.close(); rooms.delete(room.code); }
    else broadcast(room);
  });
});

server.listen(PORT, () => console.log("MicPass running on http://localhost:" + PORT));
