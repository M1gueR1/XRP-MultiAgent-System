import codec from '../../../../XRP_MicroPython/MultiAgentLib/codec.py?raw';
import constants from '../../../../XRP_MicroPython/MultiAgentLib/constants.py?raw';
import diagnostics from '../../../../XRP_MicroPython/MultiAgentLib/diagnostics.py?raw';
import init from '../../../../XRP_MicroPython/MultiAgentLib/__init__.py?raw';
import message from '../../../../XRP_MicroPython/MultiAgentLib/message.py?raw';
import node from '../../../../XRP_MicroPython/MultiAgentLib/node.py?raw';
import streamParser from '../../../../XRP_MicroPython/MultiAgentLib/stream_parser.py?raw';
import team from '../../../../XRP_MicroPython/MultiAgentLib/team.py?raw';
import topicRegistry from '../../../../XRP_MicroPython/MultiAgentLib/topic_registry.py?raw';
import transport from '../../../../XRP_MicroPython/MultiAgentLib/transport.py?raw';

export const MULTI_AGENT_LIBRARY_FILES: ReadonlyArray<{
  path: string;
  content: string;
}> = [
  { path: '/lib/MultiAgentLib/__init__.py', content: init },
  { path: '/lib/MultiAgentLib/constants.py', content: constants },
  { path: '/lib/MultiAgentLib/message.py', content: message },
  { path: '/lib/MultiAgentLib/codec.py', content: codec },
  { path: '/lib/MultiAgentLib/stream_parser.py', content: streamParser },
  { path: '/lib/MultiAgentLib/transport.py', content: transport },
  { path: '/lib/MultiAgentLib/diagnostics.py', content: diagnostics },
  { path: '/lib/MultiAgentLib/topic_registry.py', content: topicRegistry },
  { path: '/lib/MultiAgentLib/node.py', content: node },
  { path: '/lib/MultiAgentLib/team.py', content: team },
];

export function programUsesTeamCommunication(content: string): boolean {
  return /\bMultiAgentLib(?:\.|\b)|\bxrpTeam\b/.test(content);
}
