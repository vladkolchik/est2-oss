# Audio files

Music and UI sounds are **not included** in this repository. Put your own files here,
under these names; anything missing is skipped and the game simply plays without it.

| File | Used for |
|---|---|
| `main_menu.mp3` | start screen music (loop) |
| `desert_wind.mp3` | default ambience in the open world (loop) |
| `tense_combat.mp3` | combat ambience (loop) |
| `shelter_calm.mp3` | calm ambience in shelters and towns (loop) |
| `ui_menu_focus.wav` (or `.mp3`) | menu focus blip |
| `ui_menu_ok.wav` (or `.mp3`) | menu confirm |
| `ui_click.mp3`, `ui_toggle.mp3` | optional UI clicks |
| `action_confirm.mp3`, `action_error.mp3` | optional action feedback |

Only use files you have the right to use, e.g. your own recordings or tracks under
CC0 / CC-BY (credit the authors in your deployment).

- **Local development:** files in this folder are served by Vite as `/audio/...`.
- **Docker Compose (with or without Coolify):** `compose.yaml` mounts `./public/audio` into the
  app container read-only (`AUDIO_DIR=/app/audio`), so files are picked up without a rebuild.
  On Coolify the relative path lives in the resource's directory on the server
  (`/data/coolify/applications/<uuid>/public/audio`); copy the files there, e.g. with `scp`.

Everything in this folder except this README is git-ignored and excluded from Docker images.
