import {randomUUID} from 'node:crypto'
import {createRentalClient} from './rental-client'
import {runCheck} from '../../resources/run-check'

// The application only sees state and domain commands, on either endpoint.
async function main() {
    const token = process.env.RENTAL_TOKEN
    if (!token) throw new Error('set RENTAL_TOKEN to the demo bearer printed by npm start')
    const rental = createRentalClient({
        url: process.env.RENTAL_URL ?? 'http://localhost:3400',
        token,
        nodeId: 'example-' + randomUUID(),
    })
    const timeout = setTimeout(function connectionExpired() {
        rental.close()
        console.error('Rental example exceeded 20 seconds')
        process.exitCode = 1
    }, 20_000)
    const off = rental.view.store.node.bookings.on(function bookingsChanged(bookings) {
        console.log('Bookings:', Object.keys(bookings ?? {}).length)
    })
    try {
        await rental.ready
        const booking = await rental.control.book(randomUUID(), {
            itemId: 'kayak', from: '2026-10-01', to: '2026-10-03',
        })
        console.log('Booked:', booking.id)
        const cancelled = await rental.control.cancel(randomUUID(), {bookingId: booking.id})
        console.log('Cancelled:', cancelled.id)
    } finally {
        clearTimeout(timeout)
        off()
        rental.close()
    }
}

runCheck(main)
