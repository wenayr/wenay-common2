import {createAsyncQueue} from '../src/Common/async/waitRun'
import {listen} from '../src/Common/events/Listen'
import {
    attachAudioPlayer,
    attachVideoCanvas,
    createAudioSource,
    createVideoSource,
    MediaSource,
    pipeMediaPublish,
} from '../src/Common/media/media-index'

export type tMediaKind = 'cam' | 'mic' | 'screen'
type tVideoLoadMode = 'balanced' | 'max'
type tElement = (id: string) => HTMLElement
type tLog = (line: string) => void

type MediaDemoDeps = {
    remote: any
    self: string
    element: tElement
    log: tLog
    participantName: (account: string) => string
    /** Peer-published AV flags (World store) for room-tile badges; optional. */
    peerAv?: (account: string) => {camOn?: boolean, micOn?: boolean, screenOn?: boolean} | undefined
}

type RoomTile = {
    root: HTMLElement
    nameChip: HTMLElement
    badge: HTMLElement
    camCanvas: HTMLCanvasElement
    screenRoot: HTMLElement
    screenChip: HTMLElement
    screenCanvas: HTMLCanvasElement
}

type RoomView = RoomTile & {
    account: string
    previousAudioFrames: number
    cam: ReturnType<typeof attachVideoCanvas>
    screen: ReturnType<typeof attachVideoCanvas>
    player: ReturnType<typeof attachAudioPlayer>
}

type PeerView = {
    account: string
    cam: ReturnType<typeof attachVideoCanvas>
    screen: ReturnType<typeof attachVideoCanvas>
    player: ReturnType<typeof attachAudioPlayer>
}

// ============== media demo: application integration ==============

export function createMediaDemo(deps: MediaDemoDeps) {
    const {remote, self, element, log, participantName, peerAv} = deps

    function canvas(id: string) {
        return element(id) as HTMLCanvasElement
    }

    function button(id: string) {
        return element(id) as HTMLButtonElement
    }

    function clearCanvas(target: HTMLCanvasElement) {
        target.getContext('2d')?.clearRect(0, 0, target.width, target.height)
    }

    function enableFullscreen(target: HTMLCanvasElement) {
        target.addEventListener('click', function toggleFullscreen() {
            void (document.fullscreenElement == target
                ? document.exitFullscreen()
                : target.requestFullscreen?.())
        })
    }

    // -------- local capture -> relay publish --------

    function createLocalMedia() {
        const cameraResolution = element('camRes') as HTMLSelectElement
        const maxVideoButton = button('maxVideo')
        const maxVideoMode = element('maxVideoMode')
        const localCameraCanvas = canvas('localCam')
        // One capture-state feed lets every consumer (room-stage buttons, the
        // in-call control bar, the published AV flags) stay in sync with the
        // SAME account-wide sources instead of duplicating capture logic.
        const [emitCaptureChange, captureChanges] = listen<[tMediaKind]>()
        let localCameraView: ReturnType<typeof attachVideoCanvas> | null = null
        let videoLoadMode: tVideoLoadMode = 'balanced'

        function publish(kind: tMediaKind, source: MediaSource) {
            pipeMediaPublish(source[1], (frame, sentAt) => remote.publish(kind, frame, sentAt), {
                onError: error => log(`media publish ${kind} failed: ${error}`),
            })
            return source
        }

        const cameraDevice = element('camDevice') as HTMLSelectElement
        const microphoneDevice = element('micDevice') as HTMLSelectElement

        function storedDeviceId(key: string) {
            return sessionStorage.getItem(key) || undefined
        }

        function createCamera() {
            // JPEG keeps this example transport-neutral: the same binary line can go
            // through the relay today and another media transport later.
            return publish('cam', createVideoSource({
                sourceId: 'cam',
                deviceId: storedDeviceId('demo-cam-device'),
                // fps:0 immediately captures the next frame after the previous encode;
                // no timer target sits between the browser and its real throughput limit.
                fps: videoLoadMode == 'max' ? 0 : 12,
                width: Number(cameraResolution.value) || 640,
                codec: 'jpeg',
                quality: 0.68,
            }))
        }

        function createMicrophone() {
            return publish('mic', createAudioSource({
                sourceId: 'mic',
                deviceId: storedDeviceId('demo-mic-device'),
                worklet: false,
                // Larger chunks avoid flooding the shared RPC socket with hundreds
                // of tiny messages per second.
                bufferSize: 4096,
            }))
        }

        const sources: Record<tMediaKind, MediaSource> = {
            cam: createCamera(),
            mic: createMicrophone(),
            screen: publish('screen', createVideoSource({
                sourceId: 'screen',
                fps: 10,
                codec: 'jpeg',
                quality: 0.5,
                // `stream` is the intended injection point for getDisplayMedia.
                stream: () => (navigator.mediaDevices as any).getDisplayMedia({video: true}),
            })),
        }

        function attachLocalCamera() {
            localCameraView?.off()
            clearCanvas(localCameraCanvas)
            localCameraView = attachVideoCanvas(sources.cam[1], localCameraCanvas, {
                onError: error => log('local camera render failed: ' + error),
            })
        }

        // One ordered queue per kind (the library's own async primitive): a click
        // while getUserMedia is still pending queues AFTER it instead of firing a
        // second start — an orphan second stream would hold the camera with no
        // owner left to stop it. `desired` is the intent the queue converges to.
        const captureQueues: Record<tMediaKind, ReturnType<typeof createAsyncQueue>> = {
            cam: createAsyncQueue(1),
            mic: createAsyncQueue(1),
            screen: createAsyncQueue(1),
        }
        const desired: Record<tMediaKind, boolean> = {cam: false, mic: false, screen: false}

        function applyCapture(kind: tMediaKind, on: boolean) {
            return captureQueues[kind].add(async function applyCaptureState() {
                const source = sources[kind]
                if (!on) {
                    if (source.state != 'live') return source.state
                    source.stop()
                    if (kind == 'cam') clearCanvas(localCameraCanvas)
                    log(`${kind}: stopped`)
                    emitCaptureChange(kind)
                    return source.state
                }
                if (source.state == 'live') return source.state
                const state = await source.start()
                const error = source.getStats().error
                log(`${kind}: ${state}${state != 'live' && error ? ' — ' + error : ''}`)
                emitCaptureChange(kind)
                // The first permission grant unlocks device labels for the pickers.
                if (state == 'live') void refreshDevices()
                return state
            })
        }

        function ensure(kind: tMediaKind, on: boolean) {
            desired[kind] = on
            return applyCapture(kind, on)
        }

        function toggle(kind: tMediaKind) {
            // With operations in flight, invert INTENT (tap-tap during a slow
            // permission prompt converges to "off"). With an idle queue, decide
            // from the REAL state — otherwise a failed/denied auto-start leaves
            // desired=true and the first click becomes a silent no-op.
            const target = captureQueues[kind].size > 0
                ? !desired[kind]
                : sources[kind].state != 'live'
            return ensure(kind, target)
        }

        // Sources are immutable once created — a device or resolution change swaps
        // the source object through the same per-kind queue.
        function restartSource(kind: 'cam' | 'mic', make: () => MediaSource) {
            return captureQueues[kind].add(async function runRestart() {
                const wasLive = sources[kind].state == 'live'
                sources[kind].stop()
                sources[kind] = make()
                if (kind == 'cam') attachLocalCamera()
                emitCaptureChange(kind)
                if (!wasLive) return
                const state = await sources[kind].start()
                log(`${kind}: restarted — ${state}`)
                emitCaptureChange(kind)
            })
        }

        // -------- device pickers: library listDevices() + per-tab persistence --------

        async function renderDeviceOptions(select: HTMLSelectElement, source: MediaSource, storageKey: string, fallbackLabel: string) {
            const devices = await source.listDevices()
            const chosen = sessionStorage.getItem(storageKey) ?? ''
            const options = [new Option(`Default ${fallbackLabel}`, '')]
            devices.forEach((device, index) => options.push(new Option(device.label || `${fallbackLabel} ${index + 1}`, device.deviceId)))
            select.replaceChildren(...options)
            select.value = devices.some(device => device.deviceId == chosen) ? chosen : ''
        }

        async function refreshDevices() {
            await renderDeviceOptions(cameraDevice, sources.cam, 'demo-cam-device', 'camera')
            await renderDeviceOptions(microphoneDevice, sources.mic, 'demo-mic-device', 'microphone')
        }

        function bindDevicePicker(select: HTMLSelectElement, kind: 'cam' | 'mic', storageKey: string, make: () => MediaSource) {
            select.addEventListener('change', function changeCaptureDevice() {
                sessionStorage.setItem(storageKey, select.value)
                void restartSource(kind, make)
            })
        }

        function bindCaptureButton(id: string, kind: tMediaKind, startLabel: string, stopLabel: string) {
            const target = button(id)
            function render() {
                target.textContent = sources[kind].state == 'live' ? stopLabel : startLabel
            }
            target.addEventListener('click', async function toggleCapture() {
                target.disabled = true
                try { await toggle(kind) } finally {
                    target.disabled = false
                    render()
                }
            })
            captureChanges.on(function renderCaptureButton(changed) {
                if (changed == kind) render()
            })
            render()
        }

        cameraResolution.addEventListener('change', function changeCameraResolution() {
            void restartSource('cam', createCamera)
        })

        function renderVideoLoadMode() {
            const max = videoLoadMode == 'max'
            maxVideoButton.textContent = max ? 'Return to balanced video' : '🚀 Max video load'
            maxVideoButton.classList.toggle('danger', max)
            maxVideoButton.classList.toggle('secondary', !max)
            maxVideoButton.setAttribute('aria-pressed', String(max))
            maxVideoMode.textContent = max
                ? 'MAX · video only · unpaced · JPEG q68'
                : 'Balanced · 12fps · JPEG q68'
            maxVideoMode.dataset.mode = videoLoadMode
        }

        maxVideoButton.addEventListener('click', async function toggleMaxVideoLoad() {
            maxVideoButton.disabled = true
            try {
                const next: tVideoLoadMode = videoLoadMode == 'max' ? 'balanced' : 'max'
                if (next == 'max') {
                    // This experiment spends the tab's capture/encode/network budget on
                    // one line without changing the resolution selected by the user.
                    await ensure('mic', false)
                    await ensure('screen', false)
                }
                videoLoadMode = next
                await restartSource('cam', createCamera)
                if (videoLoadMode == 'max' && sources.cam.state != 'live') await ensure('cam', true)
                log(`video load mode: ${videoLoadMode}`)
            } finally {
                maxVideoButton.disabled = false
                renderVideoLoadMode()
            }
        })

        attachLocalCamera()
        bindCaptureButton('cam', 'cam', '📷 start camera', '⏹ stop camera')
        bindCaptureButton('mic', 'mic', 'Share microphone', 'Stop microphone')
        bindCaptureButton('screen', 'screen', '🖥 share screen', '⏹ stop sharing')
        bindDevicePicker(cameraDevice, 'cam', 'demo-cam-device', createCamera)
        bindDevicePicker(microphoneDevice, 'mic', 'demo-mic-device', createMicrophone)
        // Labels unlock after the first permission grant; hot-plug refreshes too.
        navigator.mediaDevices?.addEventListener?.('devicechange', function onDevicesChanged() { void refreshDevices() })
        void refreshDevices()
        enableFullscreen(localCameraCanvas)
        renderVideoLoadMode()

        return {
            sources,
            toggle,
            ensure,
            captureChanges,
            cameraStats: () => localCameraView?.stats(),
            videoLoadMode: () => videoLoadMode,
        }
    }

    // -------- one room membership -> one viewer per remote participant --------

    function createRoomMedia() {
        const peers = element('roomPeers')
        const audioButton = button('roomAudio')
        const views = new Map<string, RoomView>()
        let roomId: string | null = null
        let audioEnabled = false

        // Meet-style tile: the video fills a dark 16:9 cell; identity and AV
        // state ride small overlay chips; a screen share becomes its own tile.
        function createTile(account: string): RoomTile {
            const root = document.createElement('figure')
            root.className = 'roomTile'
            const camCanvas = document.createElement('canvas')
            camCanvas.width = 320
            camCanvas.height = 180
            const nameChip = document.createElement('div')
            nameChip.className = 'tileName'
            nameChip.textContent = participantName(account)
            const badge = document.createElement('div')
            badge.className = 'tileBadge'
            badge.textContent = '⏳ connecting…'
            root.append(camCanvas, nameChip, badge)

            const screenRoot = document.createElement('figure')
            screenRoot.className = 'roomTile roomScreenTile'
            screenRoot.hidden = true
            const screenCanvas = document.createElement('canvas')
            screenCanvas.width = 480
            screenCanvas.height = 270
            const screenChip = document.createElement('div')
            screenChip.className = 'tileName'
            screenChip.textContent = `${participantName(account)} · screen`
            screenRoot.append(screenCanvas, screenChip)

            peers.append(root, screenRoot)
            enableFullscreen(camCanvas)
            enableFullscreen(screenCanvas)
            return {root, nameChip, badge, camCanvas, screenRoot, screenChip, screenCanvas}
        }

        function attach(account: string) {
            const tile = createTile(account)
            const watch = remote.watch[account]
            const view: RoomView = {
                ...tile,
                account,
                previousAudioFrames: 0,
                cam: attachVideoCanvas(watch.cam, tile.camCanvas, {
                    onError: error => log(`room camera ${participantName(account)} failed: ${error}`),
                }),
                screen: attachVideoCanvas(watch.screen, tile.screenCanvas, {
                    onError: error => log(`room screen ${participantName(account)} failed: ${error}`),
                }),
                player: attachAudioPlayer(watch.mic, {
                    onError: error => log(`room audio ${participantName(account)} failed: ${error}`),
                }),
            }
            if (audioEnabled) view.player.enable()
            views.set(account, view)
        }

        function detach(account: string) {
            const view = views.get(account)
            if (!view) return
            view.cam.off()
            view.screen.off()
            view.player.disable()
            view.player.off()
            view.root.remove()
            view.screenRoot.remove()
            views.delete(account)
        }

        function renderEmptyState() {
            let empty = document.getElementById('roomEmpty')
            if (views.size) {
                empty?.remove()
                return
            }
            if (!empty) {
                empty = document.createElement('div')
                empty.id = 'roomEmpty'
                peers.append(empty)
            }
            empty.textContent = roomId
                ? 'You are the only participant here. Open another tab and join this room.'
                : 'Join a room to see its participants.'
        }

        function renderAudioButton() {
            audioButton.disabled = views.size == 0
            audioButton.textContent = audioEnabled
                ? 'Mute room audio'
                : 'Enable room audio'
        }

        function setMembership(nextRoomId: string | null, members: string[]) {
            // Joining a room turns listening on (the join click is the gesture);
            // a manual mute afterwards is respected until the next join.
            if (roomId == null && nextRoomId != null) audioEnabled = true
            roomId = nextRoomId
            const wanted = new Set(nextRoomId ? members.filter(account => account != self) : [])
            for (const account of Array.from(views.keys())) {
                if (!wanted.has(account)) detach(account)
            }
            for (const account of wanted) {
                if (!views.has(account)) attach(account)
            }
            if (!views.size && !roomId) audioEnabled = false
            renderAudioButton()
            renderEmptyState()
        }

        function renderStats() {
            let videoFrames = 0
            let audioFrames = 0
            let videoPerSec = 0
            let videoDrawn = 0
            let videoAgeMs = 0
            for (const view of views.values()) {
                const cam = view.cam.stats()
                const screen = view.screen.stats()
                const mic = view.player.stats()
                const audioPerSec = mic.frames - view.previousAudioFrames
                view.previousAudioFrames = mic.frames
                videoFrames += cam.frames
                audioFrames += mic.frames
                videoPerSec += cam.perSec
                videoDrawn += cam.drawn
                videoAgeMs = Math.max(videoAgeMs, cam.ageMs)

                const flags = peerAv?.(view.account)
                const name = participantName(view.account)
                view.nameChip.textContent = name
                    + (cam.width ? ` · ${cam.perSec}fps · ${cam.ageMs}ms` : '')
                    + (flags?.micOn == false ? ' · 🎙 muted' : audioPerSec ? ' · 🎙' : '')
                view.nameChip.title = cam.width ? `${cam.width}×${cam.height} · ${cam.perSec}/s` : ''
                view.badge.hidden = cam.width > 0
                view.badge.textContent = flags?.camOn == false ? '📷 camera off' : '⏳ connecting…'
                view.screenRoot.hidden = !screen.width
            }
            return {participants: views.size, videoFrames, videoPerSec, videoDrawn, videoAgeMs, audioFrames}
        }

        audioButton.addEventListener('click', function toggleRoomAudio() {
            if (!views.size) return
            audioEnabled = !audioEnabled
            for (const view of views.values()) {
                if (audioEnabled) view.player.enable()
                else view.player.disable()
            }
            renderAudioButton()
        })
        renderAudioButton()

        return {setMembership, renderStats}
    }

    // -------- accepted call -> a dynamic tile grid (1:1 and group) --------
    // Every participant (including self) is a tile in `#callGrid`. Speaker view
    // promotes the active speaker; grid view shows equal tiles. Screen shares
    // become their own wide tile. Reused for private 1:1 and host-centric group.

    type CallTile = {
        account: string
        root: HTMLElement
        canvas: HTMLCanvasElement
        nameChip: HTMLElement
        badge: HTMLElement
        cam: ReturnType<typeof attachVideoCanvas>
        screen?: {root: HTMLElement, view: ReturnType<typeof attachVideoCanvas>}
        player?: ReturnType<typeof attachAudioPlayer>
        prevAudio: number
        speaking: number
    }

    function createCallMedia(local: ReturnType<typeof createLocalMedia>) {
        const grid = element('callGrid')
        const tiles = new Map<string, CallTile>() // 'self' + each peer account
        let soundOn = true
        let activeSpeaker = ''

        function makeTile(account: string, isSelf: boolean): CallTile {
            const root = document.createElement('figure')
            root.className = 'callTile'
            root.dataset.account = account
            const cv = document.createElement('canvas')
            cv.width = 320
            cv.height = 180
            const nameChip = document.createElement('div')
            nameChip.className = 'tileName'
            nameChip.textContent = isSelf ? 'You' : participantName(account)
            const badge = document.createElement('div')
            badge.className = 'tileBadge'
            badge.textContent = isSelf ? '' : '⏳ connecting…'
            badge.hidden = isSelf
            root.append(cv, nameChip, badge)
            grid.append(root)
            enableFullscreen(cv)
            const camLine = isSelf ? local.sources.cam[1] : remote.watch[account].cam
            const cam = attachVideoCanvas(camLine, cv, {onError: error => log(`call video ${account}: ${error}`)})
            const tile: CallTile = {account, root, canvas: cv, nameChip, badge, cam, prevAudio: 0, speaking: 0}
            if (!isSelf) {
                const watch = remote.watch[account]
                tile.player = attachAudioPlayer(watch.mic, {onError: error => log(`call audio ${account}: ${error}`)})
                if (soundOn) tile.player.enable()
            }
            return tile
        }

        function ensureSelf() {
            if (tiles.has('self')) return
            tiles.set('self', makeTile('self', true))
        }

        // The self camera source object is replaced on device/resolution change —
        // re-attach so the self tile keeps drawing from the live source.
        local.captureChanges.on(function reattachSelfOnCapture(kind) {
            const selfTile = tiles.get('self')
            if (kind != 'cam' || !selfTile) return
            selfTile.cam.off()
            selfTile.cam = attachVideoCanvas(local.sources.cam[1], selfTile.canvas, {onError: error => log('self tile: ' + error)})
        })

        function attach(account: string) {
            ensureSelf()
            if (tiles.has(account)) return
            tiles.set(account, makeTile(account, false))
            log(`call tile added: ${participantName(account)}`)
        }

        function detach(account: string) {
            const tile = tiles.get(account)
            if (!tile) return
            tile.cam.off()
            tile.screen?.view.off()
            tile.screen?.root.remove()
            tile.player?.disable()
            tile.player?.off()
            tile.root.remove()
            tiles.delete(account)
        }

        function detachAll() {
            for (const account of Array.from(tiles.keys())) {
                if (account != 'self') detach(account)
            }
            const selfTile = tiles.get('self')
            if (selfTile) { selfTile.cam.off(); selfTile.root.remove(); tiles.delete('self') }
            activeSpeaker = ''
        }

        function ensureScreenTile(tile: CallTile) {
            if (tile.screen) return
            const root = document.createElement('figure')
            root.className = 'callTile callScreenTile'
            const cv = document.createElement('canvas')
            cv.width = 480
            cv.height = 270
            const chip = document.createElement('div')
            chip.className = 'tileName'
            chip.textContent = `${participantName(tile.account)} · screen`
            root.append(cv, chip)
            grid.append(root)
            enableFullscreen(cv)
            const view = attachVideoCanvas(remote.watch[tile.account].screen, cv, {onError: error => log(`call screen ${tile.account}: ${error}`)})
            tile.screen = {root, view}
        }

        function setView(view: 'speaker' | 'grid') {
            grid.dataset.layout = view
        }

        function setSound(on: boolean) {
            soundOn = on
            for (const tile of tiles.values()) {
                if (!tile.player) continue
                if (on) tile.player.enable(); else tile.player.disable()
            }
        }

        // One cheap tick: refresh every tile's chip/badge, compute who's talking.
        function renderStats() {
            let loudest = ''
            let loudestScore = 0
            const localMic = local.sources.mic.getStats()
            const selfTile = tiles.get('self')
            if (selfTile) {
                const talking = local.sources.mic.state == 'live' && (localMic.rms ?? 0) > 0.01
                selfTile.speaking = talking ? (localMic.rms ?? 0) : 0
                selfTile.root.dataset.speaking = String(talking)
                selfTile.nameChip.textContent = 'You' + (local.sources.mic.state != 'live' ? ' · 🎙 off' : talking ? ' · 🎙' : '')
                selfTile.badge.hidden = local.sources.cam.state == 'live'
                selfTile.badge.textContent = '📷 camera off'
            }
            for (const [account, tile] of tiles) {
                if (account == 'self' || !tile.player) continue
                const cam = tile.cam.stats()
                const mic = tile.player.stats()
                const perSec = mic.frames - tile.prevAudio
                tile.prevAudio = mic.frames
                const flags = peerAv?.(account)
                const talking = perSec > 0 && flags?.micOn != false
                tile.speaking = talking ? perSec : 0
                tile.root.dataset.speaking = String(talking)
                tile.nameChip.textContent = participantName(account)
                    + (flags?.micOn == false ? ' · 🎙 muted' : talking ? ' · 🎙' : '')
                tile.badge.hidden = cam.width > 0
                tile.badge.textContent = flags?.camOn == false ? '📷 camera off' : '⏳ connecting…'
                // A peer's screen share appears as (and leaves with) its own tile.
                const screen = tile.screen?.view.stats().width ?? (remote.watch[account] ? 0 : 0)
                const hasScreen = (peerAv?.(account)?.screenOn) || (tile.screen && tile.screen.view.stats().width > 0)
                if (hasScreen) ensureScreenTile(tile)
                else if (tile.screen && !hasScreen && tile.screen.view.stats().width == 0) { /* keep until detach */ }
                if (tile.speaking > loudestScore) { loudestScore = tile.speaking; loudest = account }
            }
            // Default to showing whoever is talking; hold the last speaker when
            // the room goes quiet so the stage does not flicker to nobody.
            if (loudest) activeSpeaker = loudest
            else if (!activeSpeaker || !tiles.has(activeSpeaker)) {
                const firstPeer = Array.from(tiles.keys()).find(a => a != 'self')
                activeSpeaker = firstPeer ?? 'self'
            }
            for (const [account, tile] of tiles) tile.root.dataset.active = String(account == activeSpeaker)
            return {count: tiles.size, activeSpeaker}
        }

        // Self-driven at a talk-responsive cadence — the active speaker must
        // follow the conversation, not the coarse 1s media-stats loop.
        setInterval(function tickCallMedia() { if (tiles.size) renderStats() }, 400)

        return {attach, detach, detachAll, setView, setSound, activeSpeaker: () => activeSpeaker}
    }

    // -------- one low-cost status loop for the whole media example --------

    function captureStatus(state: MediaSource['state'], error?: string | null) {
        if (state == 'requesting') return 'Requesting microphone permission…'
        if (state == 'denied') return 'Microphone permission denied'
        if (state == 'no-device') return 'No microphone found'
        // Surface the real reason ("Device in use" etc.) instead of "see log".
        if (state == 'error') return 'Microphone: ' + (error || 'error (see activity log)')
        return 'Microphone is off'
    }

    function startStats(local: ReturnType<typeof createLocalMedia>, room: ReturnType<typeof createRoomMedia>) {
        const output = element('mediaStats')
        const loadOutput = element('maxVideoMetrics')
        const microphoneStatus = element('micStatus')
        let previous = {cam: 0, mic: 0, screen: 0, camBytes: 0, camDropped: 0}

        setInterval(function renderMediaStats() {
            const parts: string[] = []
            const next = {cam: 0, mic: 0, screen: 0, camBytes: 0, camDropped: 0}
            for (const kind of ['cam', 'mic', 'screen'] as const) {
                const stats = local.sources[kind].getStats()
                next[kind] = stats.frames
                if (stats.state != 'idle') {
                    parts.push(`${kind}: ${stats.state} ${stats.frames}f ${stats.frames - previous[kind]}/s${stats.rms != null ? ` rms=${stats.rms.toFixed(3)}` : ''}`)
                }
            }

            const cameraSource = local.sources.cam.getStats()
            next.camBytes = cameraSource.bytes
            next.camDropped = cameraSource.dropped
            const previousCam = cameraSource.frames >= previous.cam ? previous.cam : 0
            const previousBytes = cameraSource.bytes >= previous.camBytes ? previous.camBytes : 0
            const previousDropped = cameraSource.dropped >= previous.camDropped ? previous.camDropped : 0
            const encodedFps = cameraSource.frames - previousCam
            const bytesPerSec = cameraSource.bytes - previousBytes
            const mibPerSec = bytesPerSec / 1024 / 1024
            const droppedPerSec = cameraSource.dropped - previousDropped
            const averageKiB = encodedFps ? bytesPerSec / encodedFps / 1024 : 0
            loadOutput.textContent = cameraSource.state == 'live'
                ? `${local.videoLoadMode().toUpperCase()} TX · ${encodedFps} encoded fps · ${mibPerSec.toFixed(2)} MiB/s · ${averageKiB.toFixed(0)} KiB/frame${local.videoLoadMode() == 'max' ? ' · unpaced' : ` · ${droppedPerSec} busy drops/s`}`
                : `${local.videoLoadMode().toUpperCase()} TX · camera is not producing frames`
            loadOutput.dataset.mode = local.videoLoadMode()

            const mic = local.sources.mic.getStats()
            microphoneStatus.textContent = mic.state == 'live'
                ? `Microphone is live · ${mic.frames - previous.mic}/s · level ${(mic.rms ?? 0).toFixed(3)}`
                : captureStatus(mic.state, mic.error)

            const camera = local.cameraStats()
            const cameraState = local.sources.cam.state
            element('localCamCap').textContent = cameraState == 'live' && camera?.width
                ? `You · ${camera.width}×${camera.height} · ${camera.perSec}/s · click = fullscreen`
                : cameraState == 'requesting'
                    ? 'You · requesting camera permission…'
                    : cameraState == 'live'
                        ? 'You · camera is starting…'
                        : cameraState == 'denied'
                            ? 'You · camera permission denied'
                            : cameraState == 'no-device'
                                ? 'You · no camera found'
                                : cameraState == 'error'
                                    ? 'You · camera: ' + (local.sources.cam.getStats().error || 'error (see log)')
                                    : 'You · camera is off'

            const roomStats = room.renderStats()
            if (roomStats.participants) {
                parts.push(`room rx: ${roomStats.videoPerSec}fps, ${roomStats.videoAgeMs}ms, ${roomStats.videoFrames - roomStats.videoDrawn} decode skips, ${roomStats.audioFrames} audio frame(s)`)
            }
            previous = next
            output.textContent = parts.join('  ·  ')
        }, 1000)
    }

    const local = createLocalMedia()
    const room = createRoomMedia()
    const call = createCallMedia(local)
    startStats(local, room)

    return {
        room: {setMembership: room.setMembership},
        // Dynamic tile grid for the call overlay — 1:1 and host-centric group.
        call: {
            attach: call.attach,
            detach: call.detach,
            detachAll: call.detachAll,
            setView: call.setView,
            setSound: call.setSound,
            activeSpeaker: call.activeSpeaker,
        },
        // Capture facade: the in-call control bar and the published AV flags
        // drive/observe the SAME sources as the room-stage buttons.
        local: {
            toggle: local.toggle,
            ensure: local.ensure,
            state: (kind: tMediaKind) => local.sources[kind].state,
            changes: local.captureChanges,
        },
    }
}

export type MediaDemo = ReturnType<typeof createMediaDemo>
