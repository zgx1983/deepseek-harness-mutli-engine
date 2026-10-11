---
description: "Adds macOS idle-sleep prevention to profiles while a DSH Session has active Agent, terminal, or owned job work."
kind: "package-bundle"
---

# dsh-keep-awake

English | [中文](README.zh.md)

## Summary

Install this bundle in a profile to keep macOS awake while an Agent, terminal command, or owned background job is active. The display may turn off. The bundle is opt-in and runs only on macOS; manual sleep, shutdown, and lid closure remain system actions.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-bundle"></a>
## Use this bundle

### Install into a profile

Run from the repository root:

```sh
dsh plugin --profile web add ./plugins/dsh-keep-awake
```

Restart the profile after installation. Desktop can load the same bundle when its separately managed profile includes it. To remove the bundle, run `dsh plugin --profile web remove dsh-keep-awake` for the CLI profile.

### What you get

The Host starts one managed `/usr/bin/caffeinate -i -w <host-pid>` process when any tracked work begins and terminates it after all tracked work ends. The `-i` assertion prevents idle system sleep while allowing the display to turn off; `-w` also makes the helper exit when the Host exits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

The bundle inserts the `keep-awake` row from `cordis.patch.yml`. `index.js` combines Agent status, terminal command activity, and owned job lifecycle events into one Host-wide active set. It reads existing Agent and terminal state when it loads, then starts and stops the helper through `ctx.subprocess` as the set changes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The [profile reference](../../apps/cli/reference/README.md) explains bundle installation and profile composition. The [subprocess package](../../packages/subprocess/subprocess/README.md) documents managed child-process ownership and shutdown.

-----

<a id="model-experience"></a>
## Model Experience

Indirect; the bundle adds no model-visible behavior.

## Known Limitations and Deferred Work

This bundle supports macOS only. It prevents idle sleep while DSH work is active; it does not override manual sleep, shutdown, or lid closure. If `caffeinate` exits unexpectedly, the Host logs the failure and retries on the next activity update.
