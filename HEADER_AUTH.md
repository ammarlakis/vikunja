# Trusted gateway authentication

This fork is based on upstream `2b45027bed14625fa502dcaaf61e4fce2f3b2cd6`.
Configure the gateway to replace client identity headers and restrict backend
network access to the gateway. `trustedproxies` checks the TCP peer, never XFF.

```yaml
auth:
  local:
    enabled: false
  header:
    enabled: true
    trustedproxies: ["10.42.0.0/24"]
    subjectheader: Al-User-Id
    usernameheader: Al-Username
    emailheader: Al-Email
    nameheader: Al-Name
    groupsheader: Al-Groups
    admingroup: app:vikunja:admin
    createuser: true
    userlinks:
      - "immutable-central-user-id=1"
```

`userlinks` explicitly links an existing numeric Vikunja user ID on first login.
New identities provision local accounts with random passwords. The existing
hidden subject field stores `header:<immutable ID>`; application usernames,
email addresses, ownership, and project permissions are preserved. When
`admingroup` is configured, comma-delimited membership grants admin and absence
removes admin on the next request. Empty `admingroup` preserves current roles.

Both APIs accept verified headers, and `/login` and `/auth/header` issue normal
sessions for clients. Supplied bearer credentials retain their validation and
scope checks and must belong to the same user as the headers. WebSocket JWTs
must also match that user. Browser startup verifies gateway identity before
restoring a saved session; identity changes clear caches and close old sockets.

Validation includes peer/header rejection, account mapping and provisioning,
API scope and identity checks, admin downgrade, real WebSocket authentication,
browser account switching, private-project isolation, and the native client's
browser authorization and PKCE token exchange. Android device callback handling
and gateway secret-path rewriting still require deployment/client validation.

Build a pinned amd64 scratch-style OCI image with SQLite support and embedded
frontend assets, without a Docker daemon:

```sh
python3 scripts/build-header-image.py /tmp/vikunja-header-image
```

The output includes `build.json` with the source commit, binary checksum,
image version, and OCI manifest digest. The build requires a clean tracked
worktree, Go with a static C toolchain, pnpm, and a CA certificate bundle.
