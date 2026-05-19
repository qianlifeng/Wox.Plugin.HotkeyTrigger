import { execFile } from "child_process"
import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"

const SHORTCUTS_SETTING_KEY = "shortcuts"
const ACTION_DELAY_MS = 120
const ICON = { ImageType: "relative" as const, ImageData: "images/app.png" }

export interface HotkeyShortcut {
  id: string
  keywords: string[]
  name: string
  hotkey: string
  enabled: boolean
  description: string
}

export interface ParsedHotkey {
  modifiers: string[]
  key: string
}

interface RawShortcut {
  keywords?: unknown
  name?: unknown
  hotkey?: unknown
  enabled?: unknown
  description?: unknown
}

interface PluginDependencies {
  sendHotkey?: (hotkey: string) => Promise<void>
  delay?: (ms: number) => Promise<void>
}

export function parseShortcuts(settingValue: string): HotkeyShortcut[] {
  if (settingValue.trim() === "") {
    return []
  }

  let rows: unknown
  try {
    rows = JSON.parse(settingValue)
  } catch {
    return []
  }

  if (!Array.isArray(rows)) {
    return []
  }

  return rows.map((row, index) => parseShortcut(row as RawShortcut, index)).filter((shortcut): shortcut is HotkeyShortcut => shortcut !== null)
}

export function parseHotkey(hotkey: string): ParsedHotkey {
  const parts = hotkey
    .split("+")
    .map(part => part.trim().toLowerCase())
    .filter(part => part.length > 0)

  if (parts.length === 0) {
    throw new Error("Hotkey is empty")
  }

  const modifiers: string[] = []
  let key = ""

  for (const part of parts) {
    const normalizedModifier = normalizeModifier(part)
    if (normalizedModifier !== null) {
      if (!modifiers.includes(normalizedModifier)) {
        modifiers.push(normalizedModifier)
      }
      continue
    }

    if (key !== "") {
      throw new Error(`Hotkey has multiple keys: ${hotkey}`)
    }
    key = normalizeKey(part)
  }

  if (key === "") {
    throw new Error(`Hotkey is missing a key: ${hotkey}`)
  }

  return { modifiers, key }
}

export function buildWindowsHotkeyCommand(hotkey: string): string[] {
  const parsed = parseHotkey(hotkey)
  const sendKeys = `${parsed.modifiers.map(toWindowsModifier).join("")}${toWindowsKey(parsed.key)}`

  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapePowerShellSingleQuoted(sendKeys)}')`]
}

export function buildMacOSHotkeyCommand(hotkey: string): string[] {
  const parsed = parseHotkey(hotkey)
  const modifiers = parsed.modifiers.map(toMacOSModifier)
  const usingClause = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : ""
  const keyCode = toMacOSKeyCode(parsed.key)

  if (keyCode !== null) {
    return ["-e", `tell application "System Events" to key code ${keyCode}${usingClause}`]
  }

  return ["-e", `tell application "System Events" to keystroke "${escapeAppleScriptString(parsed.key)}"${usingClause}`]
}

export function createPlugin(dependencies: PluginDependencies = {}): Plugin {
  let api: PublicAPI
  let shortcuts: HotkeyShortcut[] = []
  const sendHotkey = dependencies.sendHotkey ?? sendHotkeyForCurrentPlatform
  const delay = dependencies.delay ?? defaultDelay

  async function loadShortcuts(ctx: Context): Promise<void> {
    shortcuts = parseShortcuts(await api.GetSetting(ctx, SHORTCUTS_SETTING_KEY))
  }

  return {
    init: async (ctx: Context, initParams: PluginInitParams) => {
      api = initParams.API
      await loadShortcuts(ctx)
      await api.OnSettingChanged(ctx, async (settingCtx, key) => {
        if (key === SHORTCUTS_SETTING_KEY) {
          await loadShortcuts(settingCtx)
        }
      })
      await api.Log(ctx, "Info", "Init finished")
    },

    query: async (_ctx: Context, query: Query): Promise<Result[]> => {
      const search = query.Search.trim()
      if (search === "") {
        return []
      }

      return matchShortcuts(shortcuts, search).map(({ shortcut, score }) => buildResult(shortcut, score, api, sendHotkey, delay))
    }
  }
}

export const plugin: Plugin = createPlugin()

function parseShortcut(row: RawShortcut, index: number): HotkeyShortcut | null {
  const keywords = parseKeywords(toStringValue(row.keywords))
  const name = toStringValue(row.name).trim()
  const hotkey = toStringValue(row.hotkey).trim()
  const description = toStringValue(row.description).trim()

  if (keywords.length === 0 || name === "" || hotkey === "" || !toBoolean(row.enabled, true)) {
    return null
  }

  return {
    id: `${index}-${keywords.join("-")}`,
    keywords,
    name,
    hotkey,
    enabled: true,
    description
  }
}

function parseKeywords(value: string): string[] {
  const seen = new Set<string>()
  const keywords: string[] = []

  for (const keyword of value.split(",")) {
    const trimmed = keyword.trim()
    const normalized = normalizeSearchText(trimmed)
    if (normalized === "" || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    keywords.push(trimmed)
  }

  return keywords
}

function matchShortcuts(shortcuts: HotkeyShortcut[], search: string): Array<{ shortcut: HotkeyShortcut; score: number }> {
  const normalizedSearch = normalizeSearchText(search)

  return shortcuts
    .map(shortcut => ({ shortcut, score: calculateScore(shortcut, normalizedSearch) }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score || left.shortcut.name.localeCompare(right.shortcut.name))
}

function calculateScore(shortcut: HotkeyShortcut, normalizedSearch: string): number {
  const keywordScores = shortcut.keywords.map(keyword => {
    const normalizedKeyword = normalizeSearchText(keyword)
    if (normalizedKeyword === normalizedSearch) {
      return 1000
    }
    if (normalizedKeyword.startsWith(normalizedSearch)) {
      return 850
    }
    if (normalizedKeyword.includes(normalizedSearch)) {
      return 700
    }
    return 0
  })

  const bestKeywordScore = Math.max(0, ...keywordScores)
  if (bestKeywordScore > 0) {
    return bestKeywordScore
  }

  if (normalizeSearchText(shortcut.name).includes(normalizedSearch)) {
    return 500
  }

  if (normalizeSearchText(shortcut.description).includes(normalizedSearch)) {
    return 300
  }

  return 0
}

function buildResult(shortcut: HotkeyShortcut, score: number, api: PublicAPI, sendHotkey: (hotkey: string) => Promise<void>, delay: (ms: number) => Promise<void>): Result {
  const subtitle = shortcut.description === "" ? shortcut.hotkey : `${shortcut.hotkey} - ${shortcut.description}`

  return {
    Id: shortcut.id,
    Title: shortcut.name,
    SubTitle: subtitle,
    Icon: ICON,
    Score: score,
    Tails: [
      { Type: "text", Text: shortcut.keywords.join(", ") },
      { Type: "text", Text: shortcut.hotkey }
    ],
    Preview: {
      PreviewType: "text",
      PreviewData: `Keywords: ${shortcut.keywords.join(", ")}\nHotkey: ${shortcut.hotkey}${shortcut.description === "" ? "" : `\n\n${shortcut.description}`}`,
      PreviewProperties: {}
    },
    Actions: [
      {
        Name: "Trigger hotkey",
        IsDefault: true,
        ContextData: {
          hotkey: shortcut.hotkey,
          name: shortcut.name
        },
        Action: async (actionCtx: Context, actionContext: ActionContext) => {
          void actionContext
          try {
            await api.HideApp(actionCtx)
            await delay(ACTION_DELAY_MS)
            await sendHotkey(shortcut.hotkey)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await api.Log(actionCtx, "Error", `Failed to trigger hotkey ${shortcut.hotkey}: ${message}`)
            await api.Notify(actionCtx, `Failed to trigger hotkey: ${message}`)
          }
        }
      }
    ]
  }
}

async function sendHotkeyForCurrentPlatform(hotkey: string): Promise<void> {
  const platform = process.platform

  if (platform === "win32") {
    await execFileAsync("powershell", buildWindowsHotkeyCommand(hotkey))
    return
  }

  if (platform === "darwin") {
    await execFileAsync("osascript", buildMacOSHotkeyCommand(hotkey))
    return
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, error => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeModifier(value: string): string | null {
  switch (value) {
    case "ctrl":
    case "control":
      return "ctrl"
    case "alt":
    case "option":
      return "alt"
    case "shift":
      return "shift"
    case "cmd":
    case "command":
    case "meta":
      return "cmd"
    default:
      return null
  }
}

function normalizeKey(value: string): string {
  switch (value) {
    case "esc":
      return "escape"
    case "return":
      return "enter"
    case "del":
      return "delete"
    default:
      return value
  }
}

function toWindowsModifier(modifier: string): string {
  switch (modifier) {
    case "ctrl":
      return "^"
    case "alt":
      return "%"
    case "shift":
      return "+"
    case "cmd":
      throw new Error("The cmd modifier is not supported on Windows")
    default:
      throw new Error(`Unsupported modifier: ${modifier}`)
  }
}

function toWindowsKey(key: string): string {
  const namedKeys: Record<string, string> = {
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    down: "{DOWN}",
    end: "{END}",
    enter: "{ENTER}",
    escape: "{ESC}",
    home: "{HOME}",
    left: "{LEFT}",
    page_down: "{PGDN}",
    page_up: "{PGUP}",
    right: "{RIGHT}",
    space: " ",
    tab: "{TAB}",
    up: "{UP}"
  }

  if (namedKeys[key] !== undefined) {
    return namedKeys[key]
  }

  if (/^f([1-9]|1[0-2])$/.test(key)) {
    return `{${key.toUpperCase()}}`
  }

  if (key.length === 1) {
    return key.replace(/[+^%~()[\]{}]/g, "{$&}")
  }

  throw new Error(`Unsupported Windows key: ${key}`)
}

function toMacOSModifier(modifier: string): string {
  switch (modifier) {
    case "ctrl":
      return "control down"
    case "alt":
      return "option down"
    case "shift":
      return "shift down"
    case "cmd":
      return "command down"
    default:
      throw new Error(`Unsupported modifier: ${modifier}`)
  }
}

function toMacOSKeyCode(key: string): number | null {
  const keyCodes: Record<string, number> = {
    delete: 117,
    down: 125,
    end: 119,
    enter: 36,
    escape: 53,
    home: 115,
    left: 123,
    page_down: 121,
    page_up: 116,
    right: 124,
    space: 49,
    tab: 48,
    up: 126
  }

  return keyCodes[key] ?? null
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "") {
      return defaultValue
    }
    return !["false", "0", "no", "off"].includes(normalized)
  }

  return defaultValue
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}
