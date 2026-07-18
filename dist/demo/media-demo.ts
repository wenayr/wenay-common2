import {
    attachAudioPlayer,
    attachVideoCanvas,
    createAudioSource,
    createVideoSource,
    MediaSource,
    pipeMediaPublish,
} from '../src/Common/media/media-index'

type tMediaKind = 'cam' | 'mic' | 'screen'
type tElement = (id: string) => HTMLElement
type tLog = (line: string) => void

type MediaDemoDeps = {
    remote: any
    self: string
    element: tElement
    log: tLog
    participantName: (account: string) => string
}

type RoomTile = {
    root: HTMLElement
    caption: HTMLElement
    screenDetails: HTMLDetailsElement
    screenSummary: HTMLElement
    audioStatus: HTMLElement
    camCanvas: HTMLCanvasElement
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
    const {remote, self, element, log, participantName} = deps

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
        const localCameraCanvas = canvas('localCam')
        const mediaKinds = ['cam', 'mic', 'screen'] as const
        let localCameraView: ReturnType<typeof attachVideoCanvas> | null = null

        function publish(kind: tMediaKind, source: MediaSource) {
            pipeMediaPublish(source[1], (frame, sentAt) => remote.publish(kind, frame, sentAt), {
                onError: error => log(`media publish ${kind} failed: ${error}`),
            })
            return source
        }

        function createCamera() {
            // JPEG keeps this example transport-neutral: the same binary line can go
            // through the relay today and another media transport later.
            return publish('cam', createVideoSource({
                sourceId: 'cam',
                fps: 12,
                width: Number(cameraResolution.value) || 640,
                codec: 'jpeg',
                quality: 0.68,
            }))
        }

        const sources: Record<tMediaKind, MediaSource> = {
            cam: createCamera(),
            mic: publish('mic', createAudioSource({
                sourceId: 'mic',
                worklet: false,
                // Larger chunks avoid flooding the shared RPC socket with hundreds
                // of tiny messages per second.
                bufferSize: 4096,
            })),
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

        function bindCaptureButton(id: string, kind: tMediaKind, startLabel: string, stopLabel: string) {
            const target = button(id)
            target.addEventListener('click', async function toggleCapture() {
                const source = sources[kind]
                if (source.state == 'live') {
                    source.stop()
                    target.textContent = startLabel
                    if (kind == 'cam') clearCanvas(localCameraCanvas)
                    log(`${kind}: stopped`)
                    return
                }

                target.disabled = true
                target.textContent = `${startLabel} …`
                try {
                    const state = await source.start()
                    target.textContent = state == 'live' ? stopLabel : startLabel
                    const error = source.getStats().error
                    log(`${kind}: ${state}${state != 'live' && error ? ' — ' + error : ''}`)
                } finally {
                    target.disabled = false
                }
            })
        }

        cameraResolution.addEventListener('change', async function changeCameraResolution() {
            const wasLive = sources.cam.state == 'live'
            sources.cam.stop()
            sources.cam = createCamera()
            attachLocalCamera()
            if (!wasLive) return
            const state = await sources.cam.start()
            log(`cam @${cameraResolution.value}p: ${state}`)
        })

        attachLocalCamera()
        bindCaptureButton('cam', 'cam', '📷 start camera', '⏹ stop camera')
        bindCaptureButton('mic', 'mic', 'Share microphone', 'Stop microphone')
        bindCaptureButton('screen', 'screen', '🖥 share screen', '⏹ stop sharing')
        enableFullscreen(localCameraCanvas)

        return {
            sources,
            cameraStats: () => localCameraView?.stats(),
        }
    }

    // -------- one room membership -> one viewer per remote participant --------

    function createRoomMedia() {
        const peers = element('roomPeers')
        const audioButton = button('roomAudio')
        const views = new Map<string, RoomView>()
        let roomId: string | null = null
        let audioEnabled = false

        function createTile(account: string): RoomTile {
            const root = document.createElement('figure')
            root.className = 'mediaTile'

            const caption = document.createElement('figcaption')
            caption.textContent = `${participantName(account)} · camera is off`

            const camCanvas = document.createElement('canvas')
            camCanvas.className = 'mediaCanvas'
            camCanvas.width = 320
            camCanvas.height = 180

            const audioStatus = document.createElement('div')
            audioStatus.className = 'audioStatus'
            audioStatus.textContent = `${participantName(account)} · microphone is off`

            const screenDetails = document.createElement('details')
            screenDetails.className = 'roomScreen'
            const screenSummary = document.createElement('summary')
            screenSummary.textContent = `${participantName(account)} · screen is not shared`
            const screenCanvas = document.createElement('canvas')
            screenCanvas.className = 'mediaCanvas'
            screenCanvas.width = 480
            screenCanvas.height = 270
            screenDetails.append(screenSummary, screenCanvas)

            root.append(caption, camCanvas, audioStatus, screenDetails)
            peers.append(root)
            enableFullscreen(camCanvas)
            enableFullscreen(screenCanvas)
            return {root, caption, screenDetails, screenSummary, audioStatus, camCanvas, screenCanvas}
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
            roomId = nextRoomId
            const wanted = new Set(nextRoomId ? members.filter(account => account != self) : [])
            for (const account of Array.from(views.keys())) {
                if (!wanted.has(account)) detach(account)
            }
            for (const account of wanted) {
                if (!views.has(account)) attach(account)
            }
            if (!views.size) audioEnabled = false
            renderAudioButton()
            renderEmptyState()
        }

        function renderStats() {
            let videoFrames = 0
            let audioFrames = 0
            for (const view of views.values()) {
                const cam = view.cam.stats()
                const screen = view.screen.stats()
                const mic = view.player.stats()
                const audioPerSec = mic.frames - view.previousAudioFrames
                view.previousAudioFrames = mic.frames
                videoFrames += cam.frames
                audioFrames += mic.frames

                view.caption.textContent = cam.width
                    ? `${participantName(view.account)} · ${cam.width}×${cam.height} · ${cam.perSec}/s · click = fullscreen`
                    : `${participantName(view.account)} · camera is off`
                if (screen.width) {
                    view.screenSummary.textContent = `${participantName(view.account)} screen · ${screen.width}×${screen.height}`
                    view.screenDetails.open = true
                }
                view.audioStatus.textContent = audioPerSec
                    ? `${audioEnabled ? '🔊' : '🎙'} ${participantName(view.account)} · audio ${audioPerSec}/s${audioEnabled ? ' · playing' : ' · enable room audio to listen'}`
                    : `${participantName(view.account)} · audio is not being published`
            }
            return {participants: views.size, videoFrames, audioFrames}
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

    // -------- accepted private call -> one temporary peer viewer --------

    function createPrivateCallMedia() {
        const audioButton = button('audio')
        let view: PeerView | null = null

        function renderAudioButton() {
            audioButton.disabled = !view
            audioButton.textContent = view?.player.enabled
                ? '🔇 mute peer audio'
                : '🔊 enable peer audio'
        }

        function attach(account: string) {
            if (view) return
            const watch = remote.watch[account]
            view = {
                account,
                cam: attachVideoCanvas(watch.cam, canvas('peerCam'), {
                    onError: error => log('video frame render failed: ' + error),
                }),
                screen: attachVideoCanvas(watch.screen, canvas('peerScreen'), {
                    onError: error => log('screen frame render failed: ' + error),
                }),
                player: attachAudioPlayer(watch.mic, {
                    onError: error => log('audio frame failed: ' + error),
                }),
            }
            element('peerCamCap').textContent = `${participantName(account)} · waiting for camera frames`
            element('peerScreenCap').textContent = `${participantName(account)} screen · waiting for sharing`
            renderAudioButton()
            log(`watching ${participantName(account)}'s media (call active)`)
        }

        function detach() {
            if (!view) return
            view.cam.off()
            view.screen.off()
            view.player.disable()
            view.player.off()
            view = null
            for (const id of ['peerCam', 'peerScreen']) clearCanvas(canvas(id))
            element('peerCamCap').textContent = 'Remote camera · start and accept a call'
            element('peerScreenCap').textContent = 'Remote screen · available during a call'
            renderAudioButton()
            log('peer media detached (call ended)')
        }

        function renderStats() {
            if (!view) return ''
            const cam = view.cam.stats()
            const screen = view.screen.stats()
            const mic = view.player.stats()
            const peer = participantName(view.account)
            if (cam.width) element('peerCamCap').textContent = `${peer} camera · ${cam.width}×${cam.height} · click = fullscreen`
            if (screen.width) element('peerScreenCap').textContent = `${peer} screen · ${screen.width}×${screen.height} · click = fullscreen`
            if (!cam.frames && !screen.frames && !mic.frames) return ''
            return `rx: cam ${cam.frames}f/${cam.drawn}d ${cam.perSec}/s ~${cam.ageMs}ms` +
                ` · screen ${screen.frames}f/${screen.drawn}d ${screen.perSec}/s ~${screen.ageMs}ms` +
                ` · mic ${mic.frames}f ${mic.perSec}/s ~${mic.ageMs}ms`
        }

        audioButton.addEventListener('click', function togglePeerAudio() {
            if (!view) return
            if (view.player.enabled) view.player.disable()
            else view.player.enable()
            renderAudioButton()
        })
        enableFullscreen(canvas('peerCam'))
        enableFullscreen(canvas('peerScreen'))
        renderAudioButton()

        return {attach, detach, renderStats}
    }

    // -------- one low-cost status loop for the whole media example --------

    function captureStatus(state: MediaSource['state']) {
        if (state == 'requesting') return 'Requesting microphone permission…'
        if (state == 'denied') return 'Microphone permission denied'
        if (state == 'no-device') return 'No microphone found'
        if (state == 'error') return 'Microphone error (see activity log)'
        return 'Microphone is off'
    }

    function startStats(local: ReturnType<typeof createLocalMedia>, room: ReturnType<typeof createRoomMedia>, privateCall: ReturnType<typeof createPrivateCallMedia>) {
        const output = element('mediaStats')
        const microphoneStatus = element('micStatus')
        let previous = {cam: 0, mic: 0, screen: 0}

        setInterval(function renderMediaStats() {
            const parts: string[] = []
            const next = {cam: 0, mic: 0, screen: 0}
            for (const kind of ['cam', 'mic', 'screen'] as const) {
                const stats = local.sources[kind].getStats()
                next[kind] = stats.frames
                if (stats.state != 'idle') {
                    parts.push(`${kind}: ${stats.state} ${stats.frames}f ${stats.frames - previous[kind]}/s${stats.rms != null ? ` rms=${stats.rms.toFixed(3)}` : ''}`)
                }
            }

            const mic = local.sources.mic.getStats()
            microphoneStatus.textContent = mic.state == 'live'
                ? `Microphone is live · ${mic.frames - previous.mic}/s · level ${(mic.rms ?? 0).toFixed(3)}`
                : captureStatus(mic.state)

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
                                    ? 'You · camera error (see log)'
                                    : 'You · camera is off'

            const callStats = privateCall.renderStats()
            if (callStats) parts.push(callStats)
            const roomStats = room.renderStats()
            if (roomStats.participants) {
                parts.push(`room rx: ${roomStats.participants} participant(s), ${roomStats.videoFrames} camera frame(s), ${roomStats.audioFrames} audio frame(s)`)
            }
            previous = next
            output.textContent = parts.join('  ·  ')
        }, 1000)
    }

    const local = createLocalMedia()
    const room = createRoomMedia()
    const privateCall = createPrivateCallMedia()
    startStats(local, room, privateCall)

    return {
        room: {setMembership: room.setMembership},
        privateCall: {attach: privateCall.attach, detach: privateCall.detach},
    }
}

export type MediaDemo = ReturnType<typeof createMediaDemo>
