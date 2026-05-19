import { readFileSync } from "fs"
import { join } from "path"
import { Context, ExecuteResultAction, PublicAPI, Query, WoxImage } from "@wox-launcher/wox-plugin"
import { buildMacOSHotkeyCommand, buildWindowsHotkeyCommand, createPlugin, parseHotkey, parseShortcuts } from "../index"

const ctx = {} as Context

function makeQuery(search: string): Query {
  return {
    Id: "1",
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveBrowserUrl: "", ActiveWindowIcon: {} as WoxImage },
    RawQuery: search,
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Type: "input",
    Search: search,
    TriggerKeyword: "",
    Command: "",
    IsGlobalQuery(): boolean {
      return true
    }
  } as Query
}

function makeAPI(settingValue: string, calls: string[] = []): PublicAPI {
  return {
    GetSetting: async (_ctx: Context, key: string) => {
      calls.push(`get:${key}`)
      return settingValue
    },
    OnSettingChanged: async () => undefined,
    HideApp: async () => {
      calls.push("hide")
    },
    Log: async (_ctx: Context, level: "Info" | "Error" | "Debug" | "Warning", message: string) => {
      calls.push(`log:${level}:${message}`)
    },
    Notify: async (_ctx: Context, message: string) => {
      calls.push(`notify:${message}`)
    }
  } as unknown as PublicAPI
}

describe("shortcut parsing and matching", () => {
  test("returns no results when shortcuts setting is empty", async () => {
    const plugin = createPlugin({ sendHotkey: async () => undefined, delay: async () => undefined })
    await plugin.init(ctx, { PluginDirectory: "", API: makeAPI("") })

    await expect(plugin.query(ctx, makeQuery("jp"))).resolves.toEqual([])
  })

  test("filters disabled shortcut rows", () => {
    const shortcuts = parseShortcuts(
      JSON.stringify([
        { keywords: "jp", name: "Screenshot", hotkey: "ctrl+alt+a", enabled: "false" },
        { keywords: "lock", name: "Lock", hotkey: "cmd+ctrl+q", enabled: true }
      ])
    )

    expect(shortcuts.map((shortcut: { name: string }) => shortcut.name)).toEqual(["Lock"])
  })

  test("splits multiple keywords and matches any exact keyword case insensitively", async () => {
    const plugin = createPlugin({ sendHotkey: async () => undefined, delay: async () => undefined })
    await plugin.init(ctx, {
      PluginDirectory: "",
      API: makeAPI(JSON.stringify([{ keywords: "jp, shot, JP, screenshot", name: "Screenshot", hotkey: "ctrl+alt+a", enabled: true }]))
    })

    const results = await plugin.query(ctx, makeQuery("SHOT"))

    expect(results).toHaveLength(1)
    expect(results[0].Title).toBe("Screenshot")
    expect(results[0].Tails).toEqual(expect.arrayContaining([expect.objectContaining({ Type: "text", Text: "jp, shot, screenshot" }), expect.objectContaining({ Type: "text", Text: "ctrl+alt+a" })]))
  })

  test("ranks exact keyword matches above fuzzy name matches", async () => {
    const plugin = createPlugin({ sendHotkey: async () => undefined, delay: async () => undefined })
    await plugin.init(ctx, {
      PluginDirectory: "",
      API: makeAPI(
        JSON.stringify([
          { keywords: "open", name: "JP Screenshot", hotkey: "ctrl+alt+a", enabled: true },
          { keywords: "jp", name: "Quick Screenshot", hotkey: "cmd+shift+4", enabled: true }
        ])
      )
    })

    const results = await plugin.query(ctx, makeQuery("jp"))

    expect(results.map((result: { Title: string }) => result.Title)).toEqual(["Quick Screenshot", "JP Screenshot"])
  })

  test("default action hides Wox before sending the configured hotkey", async () => {
    const calls: string[] = []
    const plugin = createPlugin({
      sendHotkey: async (hotkey: string) => {
        calls.push(`send:${hotkey}`)
      },
      delay: async (ms: number) => {
        calls.push(`delay:${ms}`)
      }
    })
    await plugin.init(ctx, {
      PluginDirectory: "",
      API: makeAPI(JSON.stringify([{ keywords: "jp", name: "Screenshot", hotkey: "ctrl+alt+a", enabled: true }]), calls)
    })

    const [result] = await plugin.query(ctx, makeQuery("jp"))
    await (result.Actions?.[0] as ExecuteResultAction).Action(ctx, { ResultId: "r1", ResultActionId: "a1", ContextData: {} })

    expect(calls).toEqual(["get:shortcuts", "log:Info:Init finished", "hide", "delay:120", "send:ctrl+alt+a"])
  })
})

describe("hotkey command builders", () => {
  test("parses supported modifier aliases and key names", () => {
    expect(parseHotkey("control + option + space")).toEqual({
      modifiers: ["ctrl", "alt"],
      key: "space"
    })
  })

  test("builds a Windows PowerShell command without sending it", () => {
    expect(buildWindowsHotkeyCommand("ctrl+alt+a")).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", expect.stringContaining("SendKeys]::SendWait('^%a')")])
  })

  test("builds a macOS osascript command without sending it", () => {
    expect(buildMacOSHotkeyCommand("cmd+shift+4")).toEqual(["-e", 'tell application "System Events" to keystroke "4" using {command down, shift down}'])
  })
})

describe("plugin settings manifest", () => {
  test("localizes shortcut table field labels and tooltip formats", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "plugin.json"), "utf-8"))
    const shortcuts = manifest.SettingDefinitions.find((setting: { Value?: { Key?: string } }) => setting.Value?.Key === "shortcuts")
    const columns = Object.fromEntries(shortcuts.Value.Columns.map((column: { Key: string }) => [column.Key, column]))
    const languages = ["en_US", "zh_CN", "pt_BR", "ru_RU"]
    const i18nKeys = [
      "plugin_name",
      "plugin_description",
      "shortcuts_title",
      "shortcuts_tooltip",
      "setting_keywords_label",
      "setting_keywords_tooltip",
      "setting_name_label",
      "setting_name_tooltip",
      "setting_hotkey_label",
      "setting_hotkey_tooltip",
      "setting_enabled_label",
      "setting_enabled_tooltip",
      "setting_description_label",
      "setting_description_tooltip"
    ]

    expect(manifest.Name).toBe("i18n:plugin_name")
    expect(manifest.Description).toBe("i18n:plugin_description")
    expect(shortcuts.Value.Title).toBe("i18n:shortcuts_title")
    expect(shortcuts.Value.Tooltip).toBe("i18n:shortcuts_tooltip")
    for (const column of Object.values(columns) as Array<{ Key: string; Label?: string; Tooltip?: string }>) {
      expect(column.Label).toBe(`i18n:setting_${column.Key}_label`)
      expect(column.Tooltip).toBe(`i18n:setting_${column.Key}_tooltip`)
    }

    for (const language of languages) {
      for (const key of i18nKeys) {
        expect(manifest.I18n[language][key]).toBeTruthy()
      }
      expect(manifest.I18n[language].setting_keywords_tooltip).toContain("jp,shot,screenshot")
      expect(manifest.I18n[language].setting_hotkey_tooltip).toContain("ctrl+alt+a")
      expect(manifest.I18n[language].setting_hotkey_tooltip).toContain("cmd+shift+4")
      expect(manifest.I18n[language].setting_hotkey_tooltip).toContain("ctrl/control")
      expect(manifest.I18n[language].setting_hotkey_tooltip).toContain("cmd/command/meta")
    }
  })
})
