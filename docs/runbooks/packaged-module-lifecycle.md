# Packaged module lifecycle

Managing a `native-web-package` learning object after it is in the catalogue: what an administrator
can change, what only a new version can change, how a learner reaches it, and what to look at when
they cannot.

**Use it when:** correcting a catalogue entry, shipping a new bundle version, withdrawing something
from circulation, or diagnosing a launch that will not start.

Getting an object into the catalogue in the first place — including the part people get stuck on,
making a bundle reachable under the Player Shell origin — is in the README under
[Publishing a packaged module](../../README.md#publishing-a-packaged-module). This runbook picks up
from the moment registration has returned `201`.

Every write below requires an administrative principal, `repository_operator` membership of the
object's repository (`repository_owner` for the lifecycle transitions and deletion), and an
`Idempotency-Key` header. Every one is audited, allowed or denied.

---

## What the administrator can change

The object is on the publisher listing (`GET /api/v1/publisher/learning-objects`), and carries an
audit record for `learning_object.register` naming who registered it, into which repository, and at
which package version.

| Change | How | Effect on versions |
| --- | --- | --- |
| Title, description, duration, kind | `PATCH /api/v1/publisher/learning-objects/:id` | None — the catalogue entry only |
| The bundle it runs | `POST …/:id/versions` | New package version, becomes active |
| Publisher-authored launch configuration | `PUT …/:id/launch-context` | New object version |
| Marketplace listing and price | `PUT …/:id/marketplace-listing` | None |
| Availability | `POST …/:id/{suspend,restore,retire}` | None |

The metadata route deliberately cannot change `module_path`, `sha256` or `repository_id`. A
repointed object is a new version, and a moved one is a launch policy's problem — allowing either
here would let a reviewed catalogue entry quietly start running unreviewed code.

Two smaller rules worth knowing before you are surprised by them. A `RETIRED` object refuses every
edit. And the marketplace listing call is authoritative rather than a partial patch: omitting the
price fields means *free*, not *leave unchanged*, so re-send the current price if you are only
changing the listed flag.

## Shipping a new bundle version

```sh
curl -X POST "$RUNTIME/api/v1/publisher/learning-objects/$OBJECT_ID/versions" \
  -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"semver":"1.1.0","module_path":"/modules/photosynthesis-explorer/index.html","sha256":"…"}'
```

`201`, and the response names the new `active_package_version_id`. The object keeps its identity, so
every assignment, smart link and class result still resolves. The previous package version is not
modified — attempts already recorded against it still name content that exists, which is what keeps
a learner's evidence readable a year later.

Deploy the bundle before you publish the version, not after: between the two, launches resolve to a
`module_path` that is not being served yet.

**`LEARNING_OBJECT_CONTENT_UNSUPPORTED`** here means the object is data-authored — a quiz, video,
document, audio, ebook, LTI tool or external embed — and runs on a shared, already-reviewed player.
Publishing a code package for one would repoint it at a bundle that cannot read its content. The
edit it actually wants is new content: `PUT …/:id/content` for a quiz, or the authoring route for
its kind.

## Withdrawing, restoring, retiring

| Transition | From | To | Reversible |
| --- | --- | --- | --- |
| `POST …/:id/suspend` | `PUBLISHED` | `SUSPENDED` | Yes |
| `POST …/:id/restore` | `SUSPENDED` | `PUBLISHED` | — |
| `POST …/:id/retire` | any non-retired | `RETIRED` | **No** |

Suspending takes an object out of circulation without ending it. Retirement is the end of the line
and does not reverse: a catalogue where retirement is undone is one nobody can reason about.

Both non-publishing transitions revoke the object's smart link. That is not tidiness — a smart link
needs no sign-in, so a withdrawn object that kept one would stay reachable by anyone holding the URL.

Deletion (`DELETE /api/v1/publisher/learning-objects/:id`) exists only for something withdrawn and
never delivered, and refuses twice:

- `LEARNING_OBJECT_DELIVERABLE` — still `PUBLISHED`. Suspend or retire it first; an object in the
  catalogue is one a launch can resolve while the delete runs.
- `LEARNING_OBJECT_IN_USE` — it has been launched or assigned. Deleting it would turn a learner's
  attempt, xAPI statement or class result into a dangling reference. Retire it instead.

The second check is made again inside the deleting transaction under a row lock, so an object
launched between the check and the commit is refused rather than half-removed.

## What the learner gets

The object appears in `GET /api/v1/runtime/learning-objects?repository_id=…` for a signed-in learner
with access to that repository. The portal shows `PUBLISHED` entries.

Launching posts to `/api/v1/runtime/launches` with the object, its repository, the consumer, and
`requested_launch_mode: "embedded-iframe"`. That call:

1. creates an attempt pinned to the object version and package version active *at that moment*;
2. resolves the package URL — the object's own `PLAYER_SHELL_ORIGIN + module_path`, unless a launch
   policy routes this launch elsewhere and the object is not pinned to a shared player;
3. returns a short-lived signed descriptor, a Player Shell URL, and the attempt id.

The Shell verifies the descriptor against the published JWKS, loads the module into an iframe
sandboxed without `allow-same-origin`, and brokers a nonce'd channel to it. Evidence flows back
naming that exact package version. The learner reaches the module only as a pseudonym.

A launch for an object that is unknown, not published, retired, or in a different repository from
the one named is refused — never silently resolved to a default package.

## When a launch will not start

Work down this list; it is ordered by how often each one is the answer.

| Symptom | Check |
| --- | --- |
| `OBJECT_NOT_PUBLISHED` / `OBJECT_RETIRED` | The object's status. A suspend somebody forgot about is the usual cause. |
| `OBJECT_NOT_FOUND` on an object you can see | The `repository_id` in the launch request must match the object's own. It is a not-found rather than a mismatch error on purpose. |
| Shell loads, module never appears | Fetch the module path directly: `curl -I "$PLAYER_ORIGIN$MODULE_PATH"`. A `404` means the bundle was never deployed, or the version was published before the deploy. |
| Module loads but nothing renders | Browser console. A module fetching its own assets does so from an opaque origin, so it depends on the Shell's `Access-Control-Allow-Origin: *`; anything proxied under `/modules/` must serve it too. |
| Wrong bundle rendering | A launch policy is routing this launch. Check `governed_by_launch_policy` on the attempt. An object whose active package version is marked `shared_player` keeps its own `module_path` regardless. |
| Descriptor rejected by the Shell | Signing key and JWKS — see [key-rotation.md](key-rotation.md). |

Every response carries a `correlation_id`; use it to pull the whole request path out of the logs. The
operations console has a test launcher for reproducing a launch without a learner account.
