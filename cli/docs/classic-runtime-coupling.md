# Classic runtime coupling

The classic runtime is frozen at its current RPC passthrough surface. New
user-facing features ride the semantic gateway protocol shared with the app —
never new RPC passthrough methods on the classic runtime. The inventory below
is an upper bound: removals are allowed; additions and unexpected duplicates
are not. `@earendil-works/pi-coding-agent` imports stay inside
`src/client/runtime/` plus the import allowlist below, and only the two named
modules may patch a live `InteractiveMode` instance.

These lists were enforced by the removed `test/unit/classic-architecture.test.ts`
under the repository's no-unit-tests policy. They are now policy that reviewers
check by hand; do not weaken them silently.

## Passthrough files

- `client/runtime/remote-runtime.ts`
- `client/runtime/remote-ui.ts`
- `client/runtime/auth-bridge.ts`
- `client/runtime/local-extensions.ts`
- `client/runtime/pod-extension-bridge.ts`

## Frozen RPC passthrough inventory

Multiset of `file:enclosingPath:requestType` RPC call sites allowed across the
passthrough files:

```text
client/runtime/remote-runtime.ts:createRemoteRuntime:onEvent
client/runtime/remote-runtime.ts:prompt:prompt
client/runtime/remote-runtime.ts:refreshRemoteModels:getAvailableModels
client/runtime/remote-runtime.ts:cycleModel:setModel
client/runtime/remote-runtime.ts:cycleModel:setThinkingLevel
client/runtime/remote-runtime.ts:agent.abort:abort
client/runtime/remote-runtime.ts:session.steer:steer
client/runtime/remote-runtime.ts:session.followUp:followUp
client/runtime/remote-runtime.ts:session.abort:abort
client/runtime/remote-runtime.ts:session.waitForIdle:waitForIdle
client/runtime/remote-runtime.ts:session.setModel:setModel
client/runtime/remote-runtime.ts:session.setThinkingLevel:setThinkingLevel
client/runtime/remote-runtime.ts:session.cycleThinkingLevel:cycleThinkingLevel
client/runtime/remote-runtime.ts:session.setSteeringMode:setSteeringMode
client/runtime/remote-runtime.ts:session.setFollowUpMode:setFollowUpMode
client/runtime/remote-runtime.ts:session.compact:compact
client/runtime/remote-runtime.ts:session.setAutoCompactionEnabled:setAutoCompaction
client/runtime/remote-runtime.ts:session.setAutoRetryEnabled:setAutoRetry
client/runtime/remote-runtime.ts:session.abortRetry:abortRetry
client/runtime/remote-runtime.ts:session.executeBash:newRequestId
client/runtime/remote-runtime.ts:session.executeBash:onEvent
client/runtime/remote-runtime.ts:session.executeBash:bash
client/runtime/remote-runtime.ts:session.abortBash:abortBash
client/runtime/remote-runtime.ts:session.setSessionName:setSessionName
client/runtime/remote-runtime.ts:session.getSessionStats:getSessionStats
client/runtime/remote-runtime.ts:session.getLastAssistantText:getLastAssistantText
client/runtime/remote-runtime.ts:session.exportToHtml:exportHtml
client/runtime/remote-runtime.ts:runtimeHost.newSession:newSession
client/runtime/remote-runtime.ts:runtimeHost.switchSession:switchSession
client/runtime/remote-runtime.ts:runtimeHost.fork:fork
client/runtime/remote-runtime.ts:runtimeHost.dispose.stderrTail:getStderr
client/runtime/remote-runtime.ts:healStreamingRenderer:refreshStreamingSnapshot
client/runtime/remote-runtime.ts:createRemoteRuntime.init.setModel:setModel
client/runtime/remote-runtime.ts:createRemoteRuntime.init.setThinkingLevel:setThinkingLevel
client/runtime/remote-runtime.ts:createRemoteRuntime.init.abort:abort
client/runtime/remote-runtime.ts:createRemoteRuntime.init.compact:compact
client/runtime/remote-runtime.ts:createRemoteRuntime.init.waitForIdle:waitForIdle
client/runtime/remote-runtime.ts:quitPi:onControl
client/runtime/remote-runtime.ts:quitPi:shutdown
client/runtime/remote-ui.ts:RemoteUiBridge.constructor:onLifecycleInvalidated
client/runtime/remote-ui.ts:RemoteUiBridge.consumeExtensionRequest:respondExtensionUi
client/runtime/remote-ui.ts:RemoteUiBridge.respond:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.constructor:onLifecycleInvalidated
client/runtime/auth-bridge.ts:AuthBridge.consumeExtensionRequest:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.consumeDialog:respondExtensionUi
client/runtime/auth-bridge.ts:onAbort:respondExtensionUi
client/runtime/auth-bridge.ts:AuthBridge.invoke:prompt
client/runtime/local-extensions.ts:sendAppendEntry:prompt
client/runtime/pod-extension-bridge.ts:PodExtensionBridge.constructor:onLifecycleInvalidated
client/runtime/pod-extension-bridge.ts:PodExtensionBridge.invokeSeed:prompt
client/runtime/pod-extension-bridge.ts:PodExtensionBridge.invoke:prompt
```

## Pi import allowlist

Outside `src/client/runtime/`, only these modules may import
`@earendil-works/pi-coding-agent`:

- `account/gateway-rpc-codec.ts`
- `account/gateway-rpc.ts`
- `account/session.ts`
- `client/piversion.ts`
- `client/rpc.ts`
- `client/stream-events.ts`
- `oauth.ts`

## InteractiveMode patch sites

Only these modules may monkey-patch a live `InteractiveMode` instance:

- `client/pod-title.ts`
- `client/runtime/pod-command-overrides.ts`
