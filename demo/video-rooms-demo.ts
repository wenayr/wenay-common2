import {MediaDemo} from './media-demo'

type tVideoRoom = {id: string, name: string, members: string[]}
type tVideoRoomSnapshot = {revision: number, currentRoomId: string | null, rooms: tVideoRoom[]}

type VideoRoomsDemoDeps = {
    remote: any
    self: string
    media: MediaDemo['room']
    element: (id: string) => HTMLElement
    log: (line: string) => void
    participantName: (account: string) => string
}

// ============== room directory: application policy over media lines ==============

export async function setupVideoRooms(deps: VideoRoomsDemoDeps) {
    const {remote, self, media, element, log, participantName} = deps
    const rooms = element('rooms')
    const currentRoom = element('currentRoom')
    const help = element('roomHelp')
    const participantsTitle = element('roomParticipantsTitle')
    const name = element('roomName') as HTMLInputElement
    const createButton = element('createRoom') as HTMLButtonElement
    const leaveButton = element('leaveRoom') as HTMLButtonElement
    let appliedRevision = -1
    let refreshSerial = 0
    let lastSnapshot: tVideoRoomSnapshot | null = null
    name.value = `${participantName(self)} video room`

    async function join(room: tVideoRoom, button: HTMLButtonElement) {
        button.disabled = true
        try {
            render(await remote.join(room.id) as tVideoRoomSnapshot)
            log(`joined video room: ${room.name}`)
        } catch (error) {
            log('join room failed: ' + error)
            button.disabled = false
        }
    }

    function createRoomRow(room: tVideoRoom, selected: boolean) {
        const row = document.createElement('div')
        row.className = 'roomRow' + (selected ? ' current' : '')

        const description = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = room.name
        const members = document.createElement('span')
        members.className = 'roomMembers'
        members.textContent = room.members.length
            ? `${room.members.length} participant(s): ${room.members.map(participantName).join(', ')}`
            : 'empty room'
        description.append(title, members)

        const joinButton = document.createElement('button')
        joinButton.textContent = selected ? 'joined' : 'join'
        joinButton.disabled = selected
        joinButton.setAttribute('aria-label', selected ? `Joined ${room.name}` : `Join ${room.name}`)
        joinButton.addEventListener('click', function joinSelectedRoom() {
            void join(room, joinButton)
        })
        row.append(description, joinButton)
        return row
    }

    function render(snapshot: tVideoRoomSnapshot) {
        if (snapshot.revision < appliedRevision) return
        appliedRevision = snapshot.revision
        lastSnapshot = snapshot
        const current = snapshot.rooms.find(room => room.id == snapshot.currentRoomId)

        rooms.replaceChildren(...snapshot.rooms.map(room => createRoomRow(room, room.id == snapshot.currentRoomId)))
        currentRoom.textContent = current
            ? `In “${current.name}” · ${current.members.length} participant(s)`
            : 'Not in a room'
        help.textContent = !current
            ? 'Create a room or join an existing one. Rooms and membership update live.'
            : current.members.length == 1
                ? `You are in “${current.name}”. Open another tab and join this room to add a participant.`
                : 'Participants can publish camera, microphone, or screen. Enable room audio to listen.'
        participantsTitle.textContent = current
            ? `Participants in “${current.name}” (${current.members.length})`
            : 'Room participants'
        leaveButton.disabled = !current
        media.setMembership(current?.id ?? null, current?.members ?? [])
    }

    async function refresh() {
        const serial = ++refreshSerial
        try {
            const snapshot = await remote.snapshot() as tVideoRoomSnapshot
            if (serial == refreshSerial) render(snapshot)
        } catch (error) {
            log('room directory refresh failed: ' + error)
        }
    }

    async function createRoom() {
        createButton.disabled = true
        try {
            const snapshot = await remote.create(name.value) as tVideoRoomSnapshot
            render(snapshot)
            const current = snapshot.rooms.find(room => room.id == snapshot.currentRoomId)
            log(`created video room: ${current?.name ?? name.value}`)
        } catch (error) {
            log('create room failed: ' + error)
        } finally {
            createButton.disabled = false
        }
    }

    createButton.addEventListener('click', createRoom)
    name.addEventListener('keydown', function createRoomOnEnter(event) {
        if (event.key == 'Enter') void createRoom()
    })
    leaveButton.addEventListener('click', async function leaveRoom() {
        leaveButton.disabled = true
        try {
            render(await remote.leave() as tVideoRoomSnapshot)
            log('left video room')
        } catch (error) {
            log('leave room failed: ' + error)
        }
    })

    // Subscribe before the snapshot so a concurrent membership change cannot be lost.
    ;(remote.changes as any).on(function onRoomsChanged() { void refresh() })
    await refresh()

    return {
        /** Repaint with current display names without asking the server again. */
        rerender() {
            if (lastSnapshot) render(lastSnapshot)
        },
    }
}
