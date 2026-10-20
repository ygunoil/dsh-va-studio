## New plugin

- Repository: https://github.com/ygunoil/dsh-va-studio
- Package: `dsh-va-studio` 0.2.0
- Category: `tools`

## What it does

DeepSeek Harness plugin that connects to a VA Studio backend and registers ten tools:

- `va_studio_status` — backend health, account and configured models
- `va_studio_generate_novel` — novels (record → job → markdown)
- `va_studio_generate_screenplay` — episodic screenplays
- `va_studio_generate_drama` — short-drama project with a shot list
- `va_studio_generate_image` — text-to-image and image-to-image (1–4 images)
- `va_studio_generate_video` — one 4–30s clip (text-to-image or image-to-video)
- `va_studio_produce_video` — autopilot render for an existing project
- `va_studio_reverse_prompt` — image/video → prompt, shot spec and production package
- `va_studio_expand_prompt` — expand a short prompt
- `va_studio_job` — poll a job and return its finished content

Also ships a settings page (backend URL + account, credentials held by the Host), two skills (`va-studio`, `va-studio-reverse-prompt`), and 28 offline tests against a mock backend.

## Manifest

`package.json` declares `dsh.bundle.patch` (`cordis.patch.yml`) and `dsh.client` for the settings page. Official `@deepseek-ai/*` packages are `peerDependencies` only.

## Install

```sh
dsh plugin --profile desktop add github:ygunoil/dsh-va-studio
```

or via the prebuilt tarball in the v0.2.0 release.

## Checks

- `node --test test/*.test.mjs` — 28/28 pass
- `node test/check-client.mjs` — client bundle protocol passes
- Installed and executed in a real Harness 0.2.1-rc.2 temporary profile (all ten tools registered; generation tools exercised against a mock backend)
