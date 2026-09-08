export const page = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document processing</title><style>
body{font:17px system-ui;max-width:850px;margin:40px auto;padding:0 20px;background:#f5f7fb;color:#183043}button,select,input{font:inherit;padding:9px;margin:7px 7px 7px 0}textarea{font:inherit;width:100%;min-height:130px;padding:12px;box-sizing:border-box}article{background:white;border:1px solid #ccd6df;border-radius:10px;padding:16px;margin:12px 0}pre{white-space:pre-wrap}.notice{background:#fff0c9;padding:12px}progress{width:100%}#error{color:#a11}
</style><h1>Document processing</h1><p class="notice">Plain UTF-8 text, up to 64 KiB. Deterministic word and line counts, no AI model. Files stay in this local host's memory.</p>
<label>Local demo account <select id="account"><option>alice</option><option>bob</option></select></label>
<h2>Paste text or choose a text file</h2><textarea id="text">Hello document processing.
This sample has two lines.</textarea><br><button id="sample">Use sample text</button><button id="paste">Process pasted text</button><br>
<input id="file" type="file" accept=".txt,text/plain"><button id="upload">Upload selected file</button><p id="error"></p><h2>Your documents</h2><section id="files"></section><h2>Processing</h2><section id="jobs"></section>
<script>
let account = 'alice'
let token = ''
let generation = 0
let polling = false
let busy = false
let sessionNotice = false
const error = document.getElementById('error')
const accountPicker = document.getElementById('account')
const paste = document.getElementById('paste')
const upload = document.getElementById('upload')
function buttons() {
    paste.disabled = busy || !token
    upload.disabled = busy || !token
}
function showError(problem, mine) {
    if (mine != generation) return
    error.textContent = problem.message
    sessionNotice = !!problem.sessionRenewed
}
async function login(mine) {
    const response = await fetch('/demo-session', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({account}),
    })
    const data = await response.json()
    if (mine != generation) return
    if (!response.ok || !data.token) throw Error('Could not open demo session')
    token = data.token
    buttons()
}
async function request(path, options = {}) {
    const mine = generation
    const response = await fetch(path, {...options, headers: {...options.headers, authorization: 'Bearer ' + token}})
    if (mine != generation) throw Error('Account changed')
    if (response.status == 401) {
        await login(mine)
        throw Object.assign(Error('Demo session renewed. Check the document list before trying again.'), {sessionRenewed: true})
    }
    if (!response.ok) throw Error(await response.text())
    return response
}
async function call(method, args) {
    const response = await request('/api/' + account + '/' + method, {
        method: args ? 'POST' : 'GET', headers: {'content-type': 'application/json'},
        ...(args ? {body: JSON.stringify({args})} : {}),
    })
    const data = await response.json()
    if (!data.ok) throw Error(data.error?.message || 'Request failed')
    return data.value
}
async function download(path, name, mine) {
    try {
        const response = await request(path)
        const blob = await response.blob()
        if (mine != generation) return
        const link = document.createElement('a')
        const url = URL.createObjectURL(blob)
        link.href = url
        link.download = name
        link.click()
        setTimeout(function releaseDownload() { URL.revokeObjectURL(url) }, 1000)
    } catch (problem) { showError(problem, mine) }
}
function fileCard(file) {
    const mine = generation
    const card = document.createElement('article')
    card.textContent = file.name + ' — ' + file.state + ', ' + file.size + ' bytes'
    if (file.error) card.append(document.createTextNode(' — ' + file.error))
    if (file.state == 'uploaded') {
        const button = document.createElement('button')
        button.textContent = 'Download original'
        button.onclick = function getOriginal() { download('/bytes/' + encodeURIComponent(file.id), 'document.txt', mine) }
        card.append(button)
    }
    return card
}
function jobCard(job) {
    const mine = generation
    const card = document.createElement('article')
    const title = document.createElement('h3')
    title.textContent = job.state + ' — ' + (job.message || 'Document')
    card.append(title)
    const progress = document.createElement('progress')
    progress.max = 1
    progress.value = job.progress
    card.append(progress)
    if (job.error) card.append(document.createTextNode(job.error))
    if (job.result) {
        const report = document.createElement('pre')
        report.textContent = JSON.stringify(job.result, null, 2)
        card.append(report)
    }
    if (job.state == 'ready') {
        const button = document.createElement('button')
        button.textContent = 'Download report JSON'
        button.onclick = function getReport() { download('/reports/' + encodeURIComponent(job.id), 'report.json', mine) }
        card.append(button)
    }
    if (job.state == 'queued' || job.state == 'running') {
        const cancel = document.createElement('button')
        cancel.textContent = 'Cancel'
        cancel.onclick = async function cancelJob() {
            if (mine != generation) return
            try { await call('cancelJob', [job.id]) } catch (problem) { showError(problem, mine) }
        }
        card.append(cancel)
    }
    return card
}
async function refresh() {
    if (!token || polling) return
    polling = true
    const mine = generation
    try {
        const snapshot = await call('snapshot')
        if (mine != generation) return
        document.getElementById('files').replaceChildren(...snapshot.files.map(fileCard))
        document.getElementById('jobs').replaceChildren(...snapshot.jobs.reverse().map(jobCard))
        if (sessionNotice) {
            error.textContent = ''
            sessionNotice = false
        }
    } catch (problem) { showError(problem, mine) } finally { polling = false }
}
async function processBytes(name, bytes) {
    const mine = generation
    if (busy || !token) return
    busy = true
    buttons()
    error.textContent = ''
    try {
        if (bytes.byteLength > 65536) throw Error('Choose a UTF-8 file of at most 64 KiB')
        const pending = await call('startUpload', [{name, size: bytes.byteLength, mime: 'text/plain'}])
        if (mine != generation) return
        await request('/bytes/' + encodeURIComponent(pending.file.id), {
            method: 'PUT', headers: {'content-type': 'application/octet-stream'}, body: bytes,
        })
        if (mine != generation) return
        await call('confirmUpload', [pending.file.id])
        if (mine != generation) return
        await call('startJob', [pending.file.id, {}])
        if (mine != generation) return
        await refresh()
    } catch (problem) { showError(problem, mine) } finally {
        busy = false
        buttons()
    }
}
async function changeAccount() {
    const mine = ++generation
    account = accountPicker.value
    token = ''
    buttons()
    error.textContent = ''
    sessionNotice = false
    document.getElementById('files').replaceChildren()
    document.getElementById('jobs').replaceChildren()
    try { await login(mine) } catch (problem) { showError(problem, mine) }
    if (mine == generation) await refresh()
}
paste.onclick = function pasteText() {
    processBytes('pasted.txt', new TextEncoder().encode(document.getElementById('text').value))
}
upload.onclick = async function uploadFile() {
    const mine = generation
    try {
        const file = document.getElementById('file').files[0]
        if (!file) throw Error('Choose a text file first')
        const bytes = await file.arrayBuffer()
        if (mine == generation) await processBytes(file.name, bytes)
    } catch (problem) { showError(problem, mine) }
}
document.getElementById('sample').onclick = function sampleText() {
    document.getElementById('text').value = 'Hello document processing.\nThis sample has two lines.'
}
accountPicker.onchange = changeAccount
changeAccount()
setInterval(refresh, 400)
</script></html>`
