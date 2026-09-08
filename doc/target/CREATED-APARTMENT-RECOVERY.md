# Recovery of a runtime-created apartment

2026-09-07. Extended the existing apartment process journey from 38 to 44 checks; no production
implementation or public API changes were needed.

After the previous scenario creates an apartment/device and completes payment/code provisioning,
the check restarts only the authority again. Both device objects and the reader process remain.
It then verifies:

- The archive sequence includes the new instance's events.
- The new device can authenticate with its original credentials and sees its own lock.
- Retrying creation returns its original result; retrying booking returns the original pending
  receipt while the current booking remains paid with the same armed code.
- A fresh unlock command for the restored booking is executed by the existing dynamic device
  through the reader; a post-restart event confirms execution.
- Live process inventory replaces exactly one PID and keeps the reader. Lock identities and
  exclusion of the new booking from the original device's code projection remain correct.

The original booking input is captured once for retries so a date rollover cannot change its
meaning. This is restoration of instances through a fixed API, not runtime schema/type creation.
The bank and actuator are still simulated. The test does not prove power-loss durability, atomic
multi-journal commits, physical action deduplication after device reboot or distributed write fencing.

Source and installed journeys passed all 44 checks. Full build, installed strict types, independent
lock-policy/device/identity/stand checks, generated-copy consistency and scoped whitespace checks
passed. The installed example was extracted from the tarball and run outside the repository.
