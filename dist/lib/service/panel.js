"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.servicePanelPage = servicePanelPage;
function servicePanelPage(spec) {
    const config = JSON.stringify(spec).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.name)} panel</title>
<style>
body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #222; }
h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
.bar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.bar form { display: inline-flex; gap: .4rem; }
input, select, textarea, button { font: inherit; }
button { cursor: pointer; }
.tabs button { margin-right: .3rem; }
.tabs button.on { font-weight: bold; text-decoration: underline; }
table { border-collapse: collapse; margin: .5rem 0 1rem; }
th, td { border: 1px solid #bbb; padding: .25rem .6rem; text-align: left; vertical-align: top; font-size: .9rem; }
th { background: #f0f0f0; }
pre { background: #f6f6f6; padding: .5rem; overflow: auto; }
.hint { color: #666; font-size: .85rem; }
.err { color: #b00020; }
.cmd { display: grid; grid-template-columns: 12rem 1fr; gap: .5rem; max-width: 60rem; }
textarea { width: 100%; min-height: 6rem; }
</style>
</head>
<body>
<h1>${escapeHtml(spec.name)} — panel</h1>
<div class="bar">
  <span id="who" class="hint">anonymous</span>
  <form id="login" hidden></form>
  <button id="logout" hidden>log out</button>
  <a href="/docs">docs</a> <a href="/openapi.json">openapi.json</a>
</div>
<div class="tabs" id="tabs"></div>
<div id="view"></div>
<div id="commands" hidden>
  <h2 style="font-size:1.1rem">Commands</h2>
  <div class="cmd">
    <select id="cmdName"></select>
    <textarea id="cmdInput"></textarea>
    <button id="cmdSend">send</button>
    <pre id="cmdOut" class="hint">receipt appears here</pre>
  </div>
</div>
<p class="hint">Polls GET ${escapeHtml(spec.basePath)}/${escapeHtml(spec.name)}/views/&lt;view&gt; every second and posts to /commands/&lt;command&gt; — the same documented routes.</p>
<script>
var CFG = ${config}
var TOKEN_KEY = CFG.name + '-token'
var token = null
try { token = sessionStorage.getItem(TOKEN_KEY) } catch (e) {}
var me = null
var rights = {views: [], commands: []}
var current = null
var el = function (id) { return document.getElementById(id) }
function esc(value) {
    return String(value).replace(/[&<>"]/g, function (ch) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch] })
}
function headers(json) {
    var h = {}
    if (token) h['authorization'] = 'Bearer ' + token
    if (json) h['content-type'] = 'application/json'
    return h
}
function route(kind, name) { return CFG.basePath + '/' + CFG.name + '/' + kind + (name ? '/' + name : '') }
async function get(kind, name) {
    var answer = await (await fetch(route(kind, name), {headers: headers(false)})).json()
    if (!answer.ok) throw new Error(answer.error && answer.error.message || 'request failed')
    return answer.value
}
async function post(kind, name, args) {
    var answer = await (await fetch(route(kind, name), {method: 'POST', headers: headers(true), body: JSON.stringify({args: args})})).json()
    if (!answer.ok) throw new Error(answer.error && answer.error.message || 'request failed')
    return answer.value
}
function isRecord(v) { return v != null && typeof v == 'object' && !Array.isArray(v) }
function cell(v) { return isRecord(v) || Array.isArray(v) ? JSON.stringify(v) : v == null ? '' : v }
function table(rows, keyName) {
    var cols = []
    rows.forEach(function (r) { Object.keys(r.value).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k) }) })
    var html = '<table><tr>' + (keyName ? '<th>' + esc(keyName) + '</th>' : '') + cols.map(function (c) { return '<th>' + esc(c) + '</th>' }).join('') + '</tr>'
    rows.forEach(function (r) {
        html += '<tr>' + (keyName ? '<td>' + esc(r.key) + '</td>' : '') + cols.map(function (c) { return '<td>' + esc(cell(r.value[c])) + '</td>' }).join('') + '</tr>'
    })
    return html + '</table>'
}
function render(value) {
    if (Array.isArray(value)) {
        if (value.length && value.every(isRecord)) return table(value.map(function (v, i) { return {key: i, value: v} }), '#')
        return '<pre>' + esc(JSON.stringify(value, null, 2)) + '</pre>'
    }
    if (isRecord(value)) {
        var keys = Object.keys(value)
        if (keys.length && keys.every(function (k) { return isRecord(value[k]) })) {
            return table(keys.map(function (k) { return {key: k, value: value[k]} }), 'key')
        }
        return keys.map(function (k) { return '<h3 style="font-size:1rem;margin:.6rem 0 .2rem">' + esc(k) + '</h3>' + render(value[k]) }).join('')
    }
    return '<pre>' + esc(JSON.stringify(value)) + '</pre>'
}
function setToken(next) {
    token = next
    try { if (next) sessionStorage.setItem(TOKEN_KEY, next); else sessionStorage.removeItem(TOKEN_KEY) } catch (e) {}
}
async function refreshMe() {
    me = null
    if (token) {
        try { me = await get('me') } catch (e) { setToken(null) }
    }
    if (me) {
        rights = {views: me.views || [], commands: me.commands || []}
        el('who').textContent = me.account + ' (' + (me.roles || []).join(', ') + ')'
        el('login').hidden = true
        el('logout').hidden = false
    } else {
        rights = {views: CFG.views.filter(function (v) { return v.allow == 'public' }).map(function (v) { return v.name }), commands: []}
        el('who').textContent = 'anonymous'
        el('login').hidden = !CFG.login
        el('logout').hidden = true
    }
    if (rights.views.indexOf(current) < 0) current = rights.views[0] || null
    el('tabs').innerHTML = rights.views.map(function (v) {
        return '<button data-view="' + esc(v) + '" class="' + (v == current ? 'on' : '') + '">' + esc(v) + '</button>'
    }).join('')
    el('commands').hidden = rights.commands.length == 0
    el('cmdName').innerHTML = rights.commands.map(function (c) { return '<option>' + esc(c) + '</option>' }).join('')
    fillExample()
    await refreshView()
}
async function refreshView() {
    if (!current) { el('view').innerHTML = '<p class="hint">nothing to read</p>'; return }
    try { el('view').innerHTML = render(await get('views', current)) }
    catch (e) { el('view').innerHTML = '<p class="err">' + esc(e.message) + '</p>' }
}
function fillExample() {
    var name = el('cmdName').value
    var command = CFG.commands.filter(function (c) { return c.name == name })[0]
    el('cmdInput').value = JSON.stringify(command ? command.example : {}, null, 2)
}
if (CFG.login) {
    el('login').innerHTML = CFG.login.fields.map(function (f) {
        var type = /pass|secret|pin/i.test(f) ? 'password' : 'text'
        return '<input name="' + esc(f) + '" placeholder="' + esc(f) + '" type="' + type + '" required>'
    }).join('') + '<button>log in</button>'
    el('login').addEventListener('submit', async function (event) {
        event.preventDefault()
        var form = {}
        new FormData(event.target).forEach(function (value, key) { form[key] = value })
        try {
            var minted = await post('login', null, [form])
            setToken(minted.token)
            await refreshMe()
        } catch (e) { el('who').textContent = 'login failed: ' + e.message }
    })
}
el('logout').addEventListener('click', function () { setToken(null); refreshMe() })
el('tabs').addEventListener('click', function (event) {
    var view = event.target && event.target.getAttribute('data-view')
    if (view) { current = view; refreshMe() }
})
el('cmdName').addEventListener('change', fillExample)
el('cmdSend').addEventListener('click', async function () {
    var name = el('cmdName').value
    var requestId = 'panel-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    try {
        var input = JSON.parse(el('cmdInput').value || '{}')
        var receipt = await post('commands', name, [requestId, input])
        el('cmdOut').textContent = JSON.stringify(receipt, null, 2)
        el('cmdOut').className = ''
        refreshView()
    } catch (e) {
        el('cmdOut').textContent = e.message
        el('cmdOut').className = 'err'
    }
})
refreshMe()
setInterval(refreshView, 1000)
</script>
</body>
</html>`;
}
function escapeHtml(value) {
    return value.replace(/[&<>"]/g, function escapeChar(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
}
