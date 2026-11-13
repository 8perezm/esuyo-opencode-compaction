import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { defaultConfigPath } from "./config"
import { createGuard } from "./guard"

export default Plugin.define({
  id: "esuyo.compaction-guard",

  async setup(ctx) {
    const configured =
      typeof ctx.options.configPath === "string" ? ctx.options.configPath.trim() : ""
    const configPath = configured
      ? isAbsolute(configured)
        ? configured
        : resolve(ctx.location.directory, configured)
      : defaultConfigPath()

    const guard = await createGuard(ctx, { configPath })
    return () => guard.dispose()
  },
})
