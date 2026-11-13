import { Plugin } from "@opencode/plugin/tui"
import { CompactionGuardRpc } from "./rpc"

type ToastVariant = "info" | "success" | "warning" | "error"

/**
 * The TUI part only renders feedback. All state lives in the server part, so
 * the same RPC also works from the web client or a remote TUI.
 */
export default Plugin.define({
  id: "esuyo.compaction-guard.tui",

  setup(context) {
    const rpc = context.client.rpc(CompactionGuardRpc)
    const stop = rpc.events.on("feedback", (event) => {
      const data = event.data as { sessionID: string; text: string; variant?: ToastVariant }
      context.ui.toast.show({
        title: "Compaction guard",
        message: data.text,
        variant: data.variant ?? "info",
        duration: 7_000,
        sessionID: data.sessionID,
      })
    })
    return () => stop()
  },
})
