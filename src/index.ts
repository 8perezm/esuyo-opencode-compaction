import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { defaultConfigPath } from "./config"
import { createAutocompact } from "./autocompact"

export default Plugin.define({
  id: "esuyo.autocompact",

  async setup(ctx) {
    const configured =
      typeof ctx.options.configPath === "string" ? ctx.options.configPath.trim() : ""
    const configPath = configured
      ? isAbsolute(configured)
        ? configured
        : resolve(ctx.location.directory, configured)
      : defaultConfigPath()

    const autocompact = await createAutocompact(ctx, { configPath })
    return () => autocompact.dispose()
  },
})
