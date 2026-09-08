# Apartment instances through an existing API

2026-09-07. Acceptance extension, not a new library API or a runtime type/schema system.

## Existing coverage and missing proof

The account-ID oracle already created a second apartment through the in-process corridor to test
cross-account receipt identity. The full process journey exercised only the seeded loft and lock.
The new coverage reuses both tests instead of introducing another host/client wrapper.

The process journey now creates an apartment after the existing restart/recovery scenario, while
the authority, reader and first device remain running. It verifies guest refusal, host admission,
creation receipt reuse, the existing public projection, booking by the new apartment ID, payment
settlement and code arming by a newly admitted device. Each of the two connected devices sees its
own lock and codes. The owned server-process inventory is identical before and after these steps.

Separate resource-level coverage seeds a second host in an explicit cloned fixture and creates
apartments through the existing corridor. Exact hostBoard sets and myLock ownership are checked,
including host/device role refusal. This does not add public host signup or role assignment.

## Result and limits

Creating a new instance already works through fixed type-level commands and scoped projections.
It does not require per-object routes or a new namespace. The host/guest/device roles and actual
payment/lock business rules remain in their existing layers.

No production implementation defect was reproduced in this wave; the improvement is executable
coverage of dynamic instance creation and ownership. Existing simulated payment/device boundaries
remain. It does not prove runtime-defined entity types, entity deletion/recreation or a physical
lock deployment. Newly added instance recovery after another restart is a separate next check.

## Verification

Source account-ID/isolation test and expanded 38-step process journey pass. Full build and installed
strict types, lock policy, device lifecycle, process ownership and business checks passed. Generated
copies match and scoped whitespace checks pass. The hostBoard snapshot facade is typed as object;
the fixture derives its expected shape from the source projection and validates nested lock fields
at runtime, without changing that facade's contract.
