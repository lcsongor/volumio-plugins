# Remote Control Amplifier Plugin — Functionality Overview 🔧

**Short:** This plugin integrates Volumio with an external amplifier using LIRC (IR remote control). It listens to Volumio playback state and synchronizes the amplifier power and volume via IR key presses.

---

## Features ✅

- Detects Volumio playback state (play, pause, stop) and reacts:
  - MUSIC_PLAY → turn amplifier on and sync volume.
  - MUSIC_PAUSE / MUSIC_STOP → schedule amplifier power off after a delay.
- Volume synchronization:
  - Listens to Volumio state via socket.io and sends repeated IR volume up/down key presses to reach desired volume.
  - Uses incremental key presses with a delay between steps to avoid sending them too quickly.
- IR control via LIRC:
  - Sends `KEY_POWER`, `KEY_POWER2`, `KEY_VOLUMEUP`, `KEY_VOLUMEDOWN` by default.
  - Device name defaults to `receiver` (configurable via UI file `config.json`).
- Graceful behavior:
  - Backoff/safe retries are used for external operations and errors are logged.

---

## How it works (implementation details) 🧠

- onVolumioStart: loads plugin config and initializes internal state.
- volumeListener: connects to Volumio (`http://localhost:3000`) and listens for `pushState` events to detect volume/mute/status changes.
- statusChanged/handleEvent: maps Volumio statuses to actions (turn on/off amps, set volume).
- setVolume: compares desired volume and sends repeated LIRC keypresses (volume up/down) until target is reached.
- turnOffAmplifierWithDelay: schedules amplifier power-off after `stopToTurnOffDelay` seconds (default 60s) unless cancelled by playback resuming.

> Important constants in code:
> - `start_button = 'KEY_POWER'`
> - `stop_button = 'KEY_POWER2'`
> - `vol_up_button = 'KEY_VOLUMEUP'`
> - `vol_down_button = 'KEY_VOLUMEDOWN'`
> - `stopToTurnOffDelay = 60` (seconds)
> - `keypressTimeOut = 300` (ms between volume keypress bursts)

---

## Configuration & UI ⚙️

- The plugin exposes a single `amplifierType` setting in the UI (stored in `config.json`) for display/selection.
- Advanced behavior (keys, delays) is currently configured in `index.js` constants; to change them persistently edit the source or add UI bindings.

---

## Requirements 📋

- Volumio (plugin framework).
- LIRC installed and `lircd` running with your IR device configured (`/var/run/lirc/lircd`).
- `sampleworkingconfig/` contains example `asound.conf` and LIRC config files used by the installer.

---

## Installation (short) ▶️

Follow the standard Volumio plugin installation process: https://developers.volumio.com/plugins/plugins-overview

From the plugin directory you can run the included installer:

```bash
sudo bash install.sh        # deploys configs, restarts lircd if needed, may reboot if /boot/userconfig.txt changed
sudo bash install.sh -n     # same but do NOT reboot
```

---

## Testing & Debugging 🧪

- Verify LIRC:
  - `sudo systemctl status lircd`
  - Check `/var/log/syslog` or plugin logs for LIRC send errors.
- Verify state listener works:
  - Trigger playback in Volumio UI and check plugin logs (`volumio logs` or via the Volumio UI) — you should see `volumeListener` and `pushState` log lines.
- Verify IR actions:
  - Observing the amplifier, start playback → amplifier should power on and respond to volume changes.
  - Stop/pause → amplifier should power off after the configured delay.

---

## Development notes 🧰

- Main logic lives in `index.js`.
- UI definitions live in `UIConfig.json` and i18n strings are in `i18n/`.
- To extend behavior (different keys, delays, or more UI options), update `index.js` and add UI bindings in `UIConfig.json`.

---

## Troubleshooting Tips ⚠️

- If volume changes aren't applied, check that `lircd` is running and that the configured device and key names match your LIRC configuration.
- If the plugin doesn't react to playback, confirm socket.io is available and that `pushState` events are received by the plugin (check logs).

---

**License:** MIT (or specify)

**Author:** Your Name

