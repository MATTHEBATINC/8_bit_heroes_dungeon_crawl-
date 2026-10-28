#!/usr/bin/env node
/*
 * Pixel Legends online server  (no dependencies - just Node 16+)
 *
 *   node server.js          -> http://localhost:8080
 *   PORT=3000 node server.js
 *
 * It does four jobs:
 *   1. Serves the game page (index.html in this folder) so friends can just open your address.
 *   2. Keeps the list of usernames (unique, filtered) and friend lists in data.json.
 *   3. Tracks who is online, friend requests, game invites and the random matchmaking queue.
 *   4. Relays game messages between the two players of a match.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- Username rules (identical on the server and in the game) ----
const NAME_MIN = 3, NAME_MAX = 16;
// Safe to match anywhere inside a name (very unlikely to appear in an innocent word)
const BAD_SUBSTRINGS = [
    'fuck','fuk','shit','bitch','cunt','nigg','fagg','whore','slut','nazi','hitler','porn','penis','vagina',
    'dildo','blowjob','handjob','jizz','pussy','asshole','retard','tranny','molest','paedo','hentai','orgasm',
    'masturb','killyourself','kkk','jihad','suicide','genocide','rapist','chink','blowme','cumshot','erotic',
    'incest','childporn','nudes','whitepower','gaskids','kidnap','school shoot','schoolshoot','bomber'
];
// Words that are only blocked when they are a whole "word" in the name (e.g. ass_99, Sex, dick)
const BAD_WORDS = [
    'ass','arse','sex','anus','anal','dick','cock','tit','tits','boob','boobs','coon','spic','fag','kys','pedo',
    'heil','isis','nude','cum','kike','rape','loli','xxx','hoe','thot','milf','orgy','69','pee','poop','fart',
    'nipple','vape','weed','meth','drugs','kill','murder','die','dead','sus','sussy','amogus','sugondese','deez'
];
// Names that could be mistaken for staff / the game itself
const RESERVED_WORDS = [
    'admin','administrator','moderator','mod','staff','system','server','support','owner','official','anthropic',
    'claude','null','undefined','guest','player','user','test','root','host','god','everyone','nobody','you'
];
const RESERVED_PREFIXES = ['admin','moderator','anthropic','official','staff'];

function usernameKey(name) {
    // Case-insensitive, and look-alikes (B0b / Bob, l1l / lil) count as the same name
    return String(name).toLowerCase().replace(/_/g, '').replace(/0/g, 'o').replace(/1/g, 'l').replace(/[i]/g, 'l');
}

function usernameVariants(name) {
    const lower = name.toLowerCase();
    const maps = [
        { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','9':'g' },
        { '0':'o','1':'l','3':'e','4':'a','5':'s','7':'t','8':'b','9':'g' }
    ];
    const out = new Set();
    maps.forEach(m => {
        const leet = lower.replace(/[0-9]/g, d => m[d] || d);
        out.add(leet.replace(/_/g, ''));
        out.add(leet.replace(/_/g, '').replace(/(.)\1+/g, '$1'));
        out.add(lower.replace(/[^a-z]/g, ''));
    });
    return [...out];
}

function usernameWords(name) {
    // split on underscores and letter/digit boundaries: "Ass_99xX" -> ass, 99, xx
    return name.toLowerCase().split(/_|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);
}

function validateUsername(raw) {
    const name = String(raw == null ? '' : raw).trim();
    const nope = "That username isn't allowed. Please pick something friendlier.";
    if (name.length < NAME_MIN) return { ok: false, reason: `Usernames need at least ${NAME_MIN} characters.` };
    if (name.length > NAME_MAX) return { ok: false, reason: `Usernames can be at most ${NAME_MAX} characters.` };
    if (!/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, reason: 'Only letters, numbers and underscores are allowed.' };
    if (/^_|_$|__/.test(name)) return { ok: false, reason: 'No leading, trailing or double underscores.' };
    if (!/[A-Za-z]{3}/.test(name)) return { ok: false, reason: 'Use at least three letters in a row.' };
    if (/(.)\1{3,}/i.test(name)) return { ok: false, reason: 'Too many repeated characters in a row.' };
    if (/\d{5,}/.test(name)) return { ok: false, reason: 'Too many digits in a row.' };
    const lettersOnly = name.toLowerCase().replace(/[^a-z]/g, '');
    if (/[^aeiouy]{7,}/.test(lettersOnly)) return { ok: false, reason: 'That looks like random keyboard mashing.' };
    if (name.length >= 6 && new Set(name.toLowerCase().split('')).size <= 2) return { ok: false, reason: nope };
    if (/(..+)\1{2,}/i.test(name)) return { ok: false, reason: nope }; // "lololol", "abababab"

    const variants = usernameVariants(name);
    for (const v of variants) {
        for (const bad of BAD_SUBSTRINGS) if (v.includes(bad.replace(/\s/g, ''))) return { ok: false, reason: nope };
    }
    const words = usernameWords(name);
    const wordVariants = new Set(words);
    words.forEach(w => usernameVariants(w).forEach(v => wordVariants.add(v)));
    for (const w of wordVariants) if (BAD_WORDS.includes(w)) return { ok: false, reason: nope };
    for (const v of variants) if (BAD_WORDS.includes(v)) return { ok: false, reason: nope };
    const joined = name.toLowerCase().replace(/_/g, '');
    if (RESERVED_WORDS.includes(joined) || words.some(w => RESERVED_WORDS.includes(w) && words.length === 1)) return { ok: false, reason: 'That name is reserved.' };
    if (RESERVED_PREFIXES.some(p => joined.startsWith(p))) return { ok: false, reason: 'That name is reserved.' };
    return { ok: true, name };
}


// ---------------------------------------------------------------- storage
// Usernames and friendships are saved in up to three places so they survive restarts:
//   1. data.json next to the server (or DATA_FILE)
//   2. an optional free cloud store (Upstash Redis) when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set
//   3. each player's browser remembers their friends and re-teaches the server (see "claims" below)
let users = {};   // usernameKey -> { name, token, friends:[key], incoming:[key], outgoing:[key] }
const claimsMap = new Map();   // usernameKey -> Set(usernameKey): friends a player's browser says they have (memory only)
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UP_KEY = process.env.UPSTASH_KEY || 'bh_users';

async function upstash(cmd) {
    const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
}
async function loadStore() {
    try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).users || {}; } catch (e) { users = {}; }
    if (UP_URL && UP_TOKEN) {
        try {
            const v = await upstash(['GET', UP_KEY]);
            if (v) { const remote = JSON.parse(v).users || {}; if (Object.keys(remote).length) users = remote; }
            console.log('Cloud store connected (Upstash).');
        } catch (e) { console.error('Could not load from the cloud store:', e.message); }
    }
    console.log(`Loaded ${Object.keys(users).length} player(s).`);
}
// A "bond" is a signed receipt for a friendship. Both players' browsers keep it. After a wipe a player shows
// their bond and the server restores the friendship on its own - the friend does not need to be online.
function localSecret() {
    const f = DATA_FILE + '.secret';
    try { return fs.readFileSync(f, 'utf8'); } catch (e) {
        const v = crypto.randomBytes(32).toString('hex');
        try { fs.writeFileSync(f, v); } catch (e2) {}
        return v;
    }
}
const SECRET = process.env.SERVER_SECRET
    || (UP_TOKEN ? 'up:' + UP_TOKEN : '')
    || (process.env.RENDER_SERVICE_ID ? 'render:' + process.env.RENDER_SERVICE_ID : '')
    || localSecret();
function fp(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24); }
function bondFor(r) { return crypto.createHmac('sha256', SECRET).update(`${r.a}|${r.fa}|${r.b}|${r.fb}`).digest('hex'); }
function makeR(k1, k2) {
    const [a, b] = [k1, k2].sort();
    return { a, b, fa: fp(users[a].token), fb: fp(users[b].token) };
}

let saving = Promise.resolve();
function saveNow() {
    const json = JSON.stringify({ users });
    try { fs.writeFileSync(DATA_FILE + '.tmp', json); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { /* read-only disk is fine if the cloud store is on */ }
    if (UP_URL && UP_TOKEN) saving = saving.then(() => upstash(['SET', UP_KEY, json])).catch(e => console.error('Cloud save failed:', e.message));
    return saving;
}
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
async function shutdown() { clearTimeout(saveTimer); await saveNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------- http (serves the game)
function findGameFile() {
    if (process.env.GAME_FILE) return process.env.GAME_FILE;
    const idx = path.join(__dirname, 'index.html');
    if (fs.existsSync(idx)) return idx;
    const any = fs.readdirSync(__dirname).find(f => f.endsWith('.html'));
    return any ? path.join(__dirname, any) : null;
}
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
        const f = findGameFile();
        if (!f) { res.writeHead(404); return res.end('Put the game file (index.html) next to server.js'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
    }
    if (url === '/health') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404); res.end('Not found');
});

// ---------------------------------------------------------------- tiny WebSocket implementation
function frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

class Client {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.fragments = [];
        this.fragOpcode = 0;
        this.user = null;        // usernameKey once logged in
        this.status = 'menu';    // menu | queue | ingame
        this.partner = null;
        this.role = null;
        this.inviteTo = null;    // usernameKey I have invited
        this.alive = true;
        socket.on('data', d => this.onData(d));
        socket.on('close', () => this.onClose());
        socket.on('error', () => this.onClose());
    }
    send(obj) {
        if (!this.alive) return;
        try { this.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) {}
    }
    onData(d) {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 2) {
            const b0 = this.buf[0], b1 = this.buf[1];
            const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
            let len = b1 & 0x7f, off = 2;
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
            if (len > 2 * 1024 * 1024) return this.close();
            const need = off + (masked ? 4 : 0) + len;
            if (this.buf.length < need) return;
            let payload = this.buf.slice(off + (masked ? 4 : 0), need);
            if (masked) {
                const mask = this.buf.slice(off, off + 4);
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            this.buf = this.buf.slice(need);
            if (opcode === 8) return this.close();
            if (opcode === 9) { this.socket.write(frame(10, payload)); continue; }
            if (opcode === 10) continue;
            if (opcode === 1 || opcode === 2) { this.fragments = [payload]; this.fragOpcode = opcode; }
            else if (opcode === 0) this.fragments.push(payload);
            if (fin && (opcode === 0 || opcode === 1 || opcode === 2)) {
                const text = Buffer.concat(this.fragments).toString('utf8');
                this.fragments = [];
                let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
                try { handle(this, msg); } catch (e) { console.error('handler error', e); }
            }
        }
    }
    close() { try { this.socket.write(frame(8, Buffer.alloc(0))); } catch (e) {} try { this.socket.end(); } catch (e) {} this.onClose(); }
    onClose() {
        if (!this.alive) return;
        this.alive = false;
        disconnect(this);
    }
}

server.on('upgrade', (req, socket) => {
    if (req.url.split('?')[0] !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    new Client(socket);
});
setInterval(() => { sessions.forEach(c => { try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) {} }); }, 25000);

// ---------------------------------------------------------------- sessions, social, matchmaking
const sessions = new Map();   // usernameKey -> Client
const queues = { 2: [], 3: [] };   // Clients waiting for random teammates, by game size

function nameOf(key) { return users[key] ? users[key].name : key; }
function statusOf(key) {
    const c = sessions.get(key);
    return c ? c.status : 'offline';
}
function socialFor(key) {
    const u = users[key];
    const friends = u.friends.map(k => {
        const item = { name: nameOf(k), status: statusOf(k) };
        if (users[k]) { const r = makeR(key, k); item.r = r; item.bond = bondFor(r); }
        return item;
    });
    Object.keys(u.ghosts || {}).forEach(k => {      // friends who have not signed in since a server reset
        if (!u.friends.includes(k)) friends.push({ name: u.ghosts[k].name, status: 'offline', ghost: true, r: u.ghosts[k].r, bond: u.ghosts[k].bond });
    });
    friends.sort((x, y) => (x.status === 'offline') - (y.status === 'offline') || x.name.localeCompare(y.name));
    return { t: 'social', me: u.name, friends, incoming: u.incoming.map(nameOf), outgoing: u.outgoing.map(nameOf) };
}
function pushSocial(key) { const c = sessions.get(key); if (c && users[key]) c.send(socialFor(key)); }
function pushPresence(key) {   // tell my friends my status changed
    const u = users[key]; if (!u) return;
    u.friends.forEach(pushSocial);
}
function toast(c, msg, kind) { c.send({ t: 'toast', msg, kind: kind || 'info' }); }
function loginClient(c, key) {
    const old = sessions.get(key);
    if (old && old !== c) { old.send({ t: 'kicked' }); old.user = null; disconnectClean(old); }
    c.user = key; c.status = 'menu';
    sessions.set(key, c);
    c.send(socialFor(key));
    pushPresence(key);
}

// ----- random queues (2 or 3 players) -----
function leaveQueue(c) {
    [2, 3].forEach(n => {
        if (queues[n].includes(c)) { queues[n] = queues[n].filter(x => x !== c); broadcastQueue(n); }
    });
}
function broadcastQueue(size) { queues[size].forEach(q => q.send({ t: 'queueStatus', count: queues[size].length, size })); }

// ----- friend parties (the host invites friends; the game starts when the party is full) -----
function partyNames(party) { return { joined: party.members.map(m => nameOf(m.user)), pending: [...party.invited].map(nameOf), size: party.size }; }
function sendLobby(party) { party.members.forEach(m => m.send({ t: 'lobby', ...partyNames(party) })); }
function cancelInvite(c) {            // host cancels their party
    const party = c.party;
    if (!party) return;
    party.invited.forEach(k => { const t = sessions.get(k); if (t) t.send({ t: 'inviteCancelled', from: nameOf(c.user) }); });
    party.members.forEach(m => { if (m !== c) { m.inParty = null; if (m.status === 'lobby') m.status = 'menu'; m.send({ t: 'partyCancelled', by: nameOf(c.user) }); if (m.user) pushPresence(m.user); } });
    c.party = null;
}
function leaveParty(c) {              // an invited friend leaves the lobby
    const party = c.inParty;
    if (!party) return;
    party.members = party.members.filter(m => m !== c);
    c.inParty = null;
    if (c.status === 'lobby') c.status = 'menu';
    sendLobby(party);
    if (c.user) pushPresence(c.user);
}

// ----- rooms (a running game: slot 1 is the host who runs the game, other slots are guests) -----
function startRoom(members, mode) {
    members.forEach(m => { leaveQueue(m); cancelInvite(m); m.inParty = null; });
    const room = { members: members.slice(), host: members[0] };
    const names = members.map(m => nameOf(m.user));
    members.forEach((m, i) => {
        m.room = room; m.slot = i + 1; m.role = i === 0 ? 'host' : 'guest'; m.status = 'ingame';
        m.send({ t: 'matchFound', role: m.role, slot: m.slot, players: names, size: members.length, mode });
    });
    members.forEach(m => m.user && pushPresence(m.user));
}
function resetMember(m) { m.room = null; m.slot = 0; m.role = null; if (m.status === 'ingame') m.status = 'menu'; if (m.user) pushPresence(m.user); }
function leaveRoom(c) {
    const room = c.room;
    if (!room) return;
    const oldSlot = c.slot, name = c.user ? nameOf(c.user) : '';
    room.members = room.members.filter(m => m !== c);
    resetMember(c);
    const note = { t: 'partnerLeft', slot: oldSlot, name, hostLeft: oldSlot === 1 };
    if (oldSlot === 1) {            // the host closes the game for everyone
        room.members.forEach(m => { m.send(note); resetMember(m); });
        room.members = [];
    } else {
        room.members.forEach(m => m.send(note));
        if (room.members.length <= 1) room.members.forEach(resetMember);
    }
}
function disconnectClean(c) { leaveQueue(c); cancelInvite(c); leaveParty(c); leaveRoom(c); }
function disconnect(c) {
    disconnectClean(c);
    if (c.user && sessions.get(c.user) === c) {
        const key = c.user;
        sessions.delete(key);
        pushPresence(key);
    }
}

function requireLogin(c) { if (!c.user || !users[c.user]) { c.send({ t: 'needLogin' }); return false; } return true; }

function handle(c, m) {
    switch (m.t) {
        case 'check': {
            const v = validateUsername(m.name);
            if (!v.ok) return c.send({ t: 'checkResult', name: m.name, ok: false, reason: v.reason });
            const taken = !!users[usernameKey(v.name)];
            return c.send({ t: 'checkResult', name: m.name, ok: !taken, reason: taken ? 'That username is already taken.' : '' });
        }
        case 'register': {
            const v = validateUsername(m.name);
            if (!v.ok) return c.send({ t: 'registerResult', ok: false, reason: v.reason });
            if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 80) return c.send({ t: 'registerResult', ok: false, reason: 'Bad token.' });
            const key = usernameKey(v.name);
            if (users[key]) return c.send({ t: 'registerResult', ok: false, reason: 'That username is already taken.' });
            users[key] = { name: v.name, token: m.token, friends: [], incoming: [], outgoing: [], ghosts: {} };
            // anyone who was waiting for this friend (restored from a bond) is linked back up now
            Object.keys(users).forEach(uk => {
                const g = users[uk].ghosts && users[uk].ghosts[key];
                if (!g) return;
                const expect = g.r.a === key ? g.r.fa : g.r.fb;
                if (expect === fp(m.token)) {
                    delete users[uk].ghosts[key];
                    if (!users[uk].friends.includes(key)) users[uk].friends.push(key);
                    if (!users[key].friends.includes(uk)) users[key].friends.push(uk);
                }
            });
            saveSoon();
            c.send({ t: 'registerResult', ok: true, name: v.name });
            return loginClient(c, key);
        }
        case 'login': {
            const key = usernameKey(m.name || '');
            const u = users[key];
            if (!u) return c.send({ t: 'loginResult', ok: false, reason: 'unknown' });
            if (u.token !== m.token) return c.send({ t: 'loginResult', ok: false, reason: 'badtoken' });
            c.send({ t: 'loginResult', ok: true, name: u.name });
            return loginClient(c, key);
        }
        case 'friendRequest': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || '');
            const target = users[tk];
            if (!target) return toast(c, `No player named "${String(m.name).slice(0, 20)}" exists.`, 'error');
            if (tk === me) return toast(c, "You can't friend yourself.", 'error');
            const mine = users[me];
            if (mine.friends.includes(tk)) return toast(c, `You and ${target.name} are already friends.`, 'error');
            if (mine.outgoing.includes(tk)) return toast(c, `You already sent ${target.name} a request.`, 'error');
            if (mine.incoming.includes(tk)) {   // they already asked me: accept
                mine.incoming = mine.incoming.filter(k => k !== tk); target.outgoing = target.outgoing.filter(k => k !== me);
                mine.friends.push(tk); target.friends.push(me);
                saveSoon(); pushSocial(me); pushSocial(tk);
                toast(c, `You and ${target.name} are now friends!`, 'good');
                const t = sessions.get(tk); if (t) toast(t, `${mine.name} accepted your friend request!`, 'good');
                return;
            }
            mine.outgoing.push(tk); target.incoming.push(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            toast(c, `Friend request sent to ${target.name}.`, 'good');
            const t = sessions.get(tk); if (t) toast(t, `${mine.name} sent you a friend request!`, 'info');
            return;
        }
        case 'friendAccept': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            if (!other || !mine.incoming.includes(tk)) return toast(c, 'That request is no longer there.', 'error');
            mine.incoming = mine.incoming.filter(k => k !== tk); other.outgoing = other.outgoing.filter(k => k !== me);
            if (!mine.friends.includes(tk)) mine.friends.push(tk);
            if (!other.friends.includes(me)) other.friends.push(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            toast(c, `You and ${other.name} are now friends!`, 'good');
            const t = sessions.get(tk); if (t) toast(t, `${mine.name} accepted your friend request!`, 'good');
            return;
        }
        case 'friendDecline': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            mine.incoming = mine.incoming.filter(k => k !== tk);
            if (other) other.outgoing = other.outgoing.filter(k => k !== me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            return;
        }
        case 'claims': {
            if (!requireLogin(c)) return;
            const me = c.user, mine = users[me];
            mine.ghosts = mine.ghosts || {};
            let changed = false;
            const touched = new Set();
            // (1) signed bonds: restore a friendship right away, even if the friend is offline
            (Array.isArray(m.bonds) ? m.bonds : []).slice(0, 500).forEach(b => {
                if (!b || !b.r || typeof b.bond !== 'string' || bondFor(b.r) !== b.bond) return;   // forged or from another server
                const r = b.r, myFp = fp(mine.token);
                let other, otherFp;
                if (r.a === me && r.fa === myFp) { other = r.b; otherFp = r.fb; }
                else if (r.b === me && r.fb === myFp) { other = r.a; otherFp = r.fa; }
                else return;
                if (other === me) return;
                const ou = users[other];
                if (!ou) {      // friend hasn't come back yet: remember them, link up when they do
                    if (!mine.ghosts[other] && usernameKey(String(b.name || '')) === other) { mine.ghosts[other] = { name: String(b.name).slice(0, 16), r, bond: b.bond }; changed = true; }
                    return;
                }
                if (fp(ou.token) !== otherFp) return;    // that name now belongs to someone else
                if (!mine.friends.includes(other)) { mine.friends.push(other); changed = true; touched.add(other); }
                if (!ou.friends.includes(me)) { ou.friends.push(me); changed = true; touched.add(other); }
                if (mine.ghosts[other]) { delete mine.ghosts[other]; changed = true; }
                if (ou.ghosts && ou.ghosts[me]) delete ou.ghosts[me];
                [mine, ou].forEach(u => { u.incoming = u.incoming.filter(x => x !== other && x !== me); u.outgoing = u.outgoing.filter(x => x !== other && x !== me); });
            });
            // (2) older friendships without a bond: restored when BOTH browsers claim each other
            const set = new Set((Array.isArray(m.names) ? m.names : []).slice(0, 500).map(n => usernameKey(String(n))));
            claimsMap.set(me, set);
            set.forEach(k => {
                const other = users[k];
                if (k === me || !other) return;
                const theirs = claimsMap.get(k);
                if ((theirs && theirs.has(me)) || other.friends.includes(me)) {
                    if (!mine.friends.includes(k)) { mine.friends.push(k); changed = true; touched.add(k); }
                    if (!other.friends.includes(me)) { other.friends.push(me); changed = true; touched.add(k); }
                    mine.incoming = mine.incoming.filter(x => x !== k); mine.outgoing = mine.outgoing.filter(x => x !== k);
                    other.incoming = other.incoming.filter(x => x !== me); other.outgoing = other.outgoing.filter(x => x !== me);
                }
            });
            if (changed) { saveSoon(); pushSocial(me); touched.forEach(pushSocial); }
            return;
        }
        case 'friendRemove': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            mine.friends = mine.friends.filter(k => k !== tk);
            if (other) other.friends = other.friends.filter(k => k !== me);
            if (claimsMap.get(me)) claimsMap.get(me).delete(tk);
            if (claimsMap.get(tk)) claimsMap.get(tk).delete(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            return;
        }
        case 'queueJoin': {
            if (!requireLogin(c) || c.status !== 'menu') return;
            const size = m.size === 3 ? 3 : 2;
            c.status = 'queue'; queues[size].push(c);
            pushPresence(c.user);
            if (queues[size].length >= size) {
                const members = queues[size].splice(0, size);
                members.forEach(x => { x.status = 'menu'; });
                startRoom(members, 'random');
            } else broadcastQueue(size);
            return;
        }
        case 'queueLeave': {
            if (!c.user) return;
            if (c.status === 'queue') { leaveQueue(c); c.status = 'menu'; pushPresence(c.user); }
            return;
        }
        case 'invite': {
            if (!requireLogin(c)) return;
            const size = m.size === 3 ? 3 : 2;
            if (c.party) { if (c.party.size !== size) return c.send({ t: 'inviteResult', ok: false, reason: 'You already have a different party open.' }); }
            else if (c.status !== 'menu') return;
            const tk = usernameKey(m.name || ''), mine = users[c.user];
            if (!mine.friends.includes(tk)) return c.send({ t: 'inviteResult', ok: false, reason: 'You can only invite friends.' });
            const t = sessions.get(tk);
            if (!t) return c.send({ t: 'inviteResult', ok: false, reason: `${nameOf(tk)} is offline.` });
            if (t.status !== 'menu') return c.send({ t: 'inviteResult', ok: false, reason: `${nameOf(tk)} is busy right now.` });
            if (!c.party) { c.party = { host: c, size, members: [c], invited: new Set() }; c.status = 'lobby'; pushPresence(c.user); }
            const party = c.party;
            if (party.invited.has(tk)) return c.send({ t: 'inviteResult', ok: false, reason: `You already invited ${nameOf(tk)}.` });
            const open = party.size - party.members.length;
            if (party.invited.size >= open) return c.send({ t: 'inviteResult', ok: false, reason: `Your party only has room for ${party.size - 1} friend${party.size > 2 ? 's' : ''}.` });
            party.invited.add(tk);
            t.send({ t: 'inviteReceived', from: mine.name, size: party.size });
            c.send({ t: 'inviteResult', ok: true, name: nameOf(tk), ...partyNames(party) });
            sendLobby(party);
            return;
        }
        case 'inviteCancel': { if (c.user) { cancelInvite(c); if (c.status === 'lobby') { c.status = 'menu'; pushPresence(c.user); } } return; }
        case 'lobbyLeave': { if (c.user) leaveParty(c); return; }
        case 'inviteRespond': {
            if (!requireLogin(c)) return;
            const ik = usernameKey(m.name || ''), inviter = sessions.get(ik);
            const party = inviter && inviter.party;
            if (!party || !party.invited.has(c.user)) return toast(c, 'That invite is no longer valid.', 'error');
            if (!m.accept) {
                party.invited.delete(c.user);
                inviter.send({ t: 'inviteDeclined', by: nameOf(c.user) });
                sendLobby(party);
                return;
            }
            if (c.status !== 'menu') return toast(c, 'That invite is no longer valid.', 'error');
            party.invited.delete(c.user);
            party.members.push(c);
            c.inParty = party; c.status = 'lobby';
            pushPresence(c.user);
            if (party.members.length >= party.size) {
                const members = party.members.slice();
                members.forEach(x => { x.party = null; x.inParty = null; x.status = 'menu'; });
                startRoom(members, 'friend');
            } else sendLobby(party);
            return;
        }
        case 'game': {
            const room = c.room;
            if (!room) return;
            if (c.slot === 1) room.members.forEach(g => { if (g !== c && (!m.to || g.slot === m.to)) g.send({ t: 'game', data: m.data }); });
            else if (room.host && room.host.alive) room.host.send({ t: 'game', from: c.slot, data: m.data });
            return;
        }
        case 'leaveMatch': { leaveRoom(c); return; }
    }
}

loadStore().then(() => server.listen(PORT, () => {
    console.log(`Pixel Legends server running on http://localhost:${PORT}`);
    console.log('Share this address (or your public URL) with friends so they can play online with you.');
}));
