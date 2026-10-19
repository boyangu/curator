// Agent data facade — the renderer's only touchpoint for the agent:* IPC
// surface (boundary rule F2: window.api lives under renderer/data/). 1:1
// with the channels; no reshaping.

import type { AgentEvent, AgentResultSet, AgentSessionDetail, AgentSessionSummary, AgentStatus, AgentViewContext } from '@curator/core';
import type { AgentConfigInput, AgentConfigRedacted } from '../../ipc.js';

export const agentApi = {
	status: (): Promise<AgentStatus> => window.api['agent:status'](),
	getConfig: (): Promise<AgentConfigRedacted | null> => window.api['agent:get-config'](),
	setConfig: (input: AgentConfigInput): Promise<AgentStatus> => window.api['agent:set-config'](input),
	send: (req: { sessionId?: string; text: string; context?: AgentViewContext }): Promise<{ status: 'running'; sessionId: string; turnId: string }> =>
		window.api['agent:send'](req),
	cancel: (sessionId: string): Promise<void> => window.api['agent:cancel'](sessionId),
	listSessions: (): Promise<AgentSessionSummary[]> => window.api['agent:list-sessions'](),
	getSession: (sessionId: string): Promise<AgentSessionDetail | null> => window.api['agent:get-session'](sessionId),
	newSession: (): Promise<AgentSessionSummary> => window.api['agent:new-session'](),
	deleteSession: (sessionId: string): Promise<void> => window.api['agent:delete-session'](sessionId),
	getResultSet: (resultSetId: string): Promise<AgentResultSet | null> => window.api['agent:get-result-set'](resultSetId),
	onEvent: (cb: (e: AgentEvent) => void): (() => void) => window.api.onAgentEvent(cb),
};
