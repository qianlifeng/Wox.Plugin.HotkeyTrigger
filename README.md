# HotkeyTrigger

Trigger configured system hotkeys from global Wox keywords.

## Install

```sh
wpm install HotkeyTrigger
```

## Configure

Open the plugin settings and add rows to the `Shortcuts` table:

| Field       | Description                                                    | Example                   |
| ----------- | -------------------------------------------------------------- | ------------------------- |
| Keywords    | Comma-separated Wox keywords. Any keyword can trigger the row. | `jp,shot,screenshot`      |
| Name        | Result title shown in Wox.                                     | `Screenshot`              |
| Hotkey      | System hotkey to send after selecting the result.              | `ctrl+alt+a`              |
| Enabled     | Whether this row is active.                                    | `true`                    |
| Description | Optional result subtitle text.                                 | `Trigger screenshot tool` |

After configuration, type a keyword globally in Wox, for example `jp`, then press Enter on the matching result.

## Hotkey Syntax

Use `+` between modifiers and the final key:

- Modifiers: `ctrl`/`control`, `alt`/`option`, `shift`, `cmd`/`command`/`meta`
- Examples: `ctrl+alt+a`, `cmd+shift+4`, `control+option+space`

Windows supports `ctrl`, `alt`, and `shift`. macOS supports `ctrl`, `alt`/`option`, `shift`, and `cmd`.

## macOS Permission

macOS requires Accessibility permission for the process that runs Wox/plugin actions before simulated hotkeys can be sent.
