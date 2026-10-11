---
kind: upgrade-guide
description: "Remove the session_create tool and its profile configuration."
---

# Remove session_create

English | [中文](guide.zh.md)

## Change

The `@deepseek-ai/dsh-tool-session-create` package and `session_create` tool are removed. Existing Sessions remain available; create new Sessions through the application interface.

## Migration

1. Remove the `tool-session-create` row from profile patches and custom Cordis configurations.
2. Remove direct dependencies on `@deepseek-ai/dsh-tool-session-create` from custom resolver manifests.
3. Restart the application and confirm it starts without missing-plugin errors.
