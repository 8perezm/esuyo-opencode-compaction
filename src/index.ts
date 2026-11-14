import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { defaultConfigPath } from "./config"
import { createCompaction } from "./compaction"

export default Plugin.define({
  id: "esuyo.compaction",

  async setup(ctx) {
    const configured =
      typeof ctx.options.configPath === "string" ? ctx.options.configPath.trim() : ""
    const configPath = configured
      ? isAbsolute(configured)
        ? configured
        : resolve(ctx.location.directory, configured)
      : defaultConfigPath()

    const compaction = await createCompaction(ctx, { configPath })
    return () => compaction.dispose()
  },
})
