import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import { pythonGenerator } from 'blockly/python';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/emotions/customEmotionStore', () => ({
  listCustomEmotions: vi.fn().mockResolvedValue([]),
}));

import '../xrp_blocks';
import '../xrp_blocks_python';
import { blocklyToPython } from '../blocklyCodegen';
import BlocklyConfigs from '../xrp_blockly_configs';

function connectValue(parent: Blockly.Block, inputName: string, child: Blockly.Block): void {
  const target = parent.getInput(inputName)?.connection;
  if (!target || !child.outputConnection) throw new Error(`Missing ${inputName} value connection.`);
  target.connect(child.outputConnection);
}

describe('XRP team communication Blockly blocks', () => {
  let workspace: Blockly.Workspace;

  beforeEach(() => {
    workspace = new Blockly.Workspace();
  });

  afterEach(() => workspace.dispose());

  it('generates a latest-value distance broadcast with automatic setup', () => {
    const broadcast = workspace.newBlock('xrp_team_broadcast');
    broadcast.setFieldValue('distance', 'CHANNEL');
    broadcast.setFieldValue('LATEST', 'MODE');
    const distance = workspace.newBlock('xrp_getsonardist');
    connectValue(broadcast, 'VALUE', distance);

    const code = pythonGenerator.workspaceToCode(workspace);
    expect(code).toContain('from MultiAgentLib.team import get_default_team');
    expect(code).toContain('xrpTeam = get_default_team()');
    expect(code).toContain('xrpTeam.broadcast("distance", rangefinder.distance(), mode="latest")');
  });

  it('serializes Blockly sessions as runnable Python with embedded block metadata', () => {
    workspace.newBlock('xrp_team_start');

    const code = blocklyToPython(workspace);

    expect(code).toContain('xrpTeam.start()');
    expect(code).toContain('##XRPBLOCKS ');
  });

  it('generates the student-friendly start block as a ready wait loop', () => {
    workspace.newBlock('xrp_team_start');

    const code = pythonGenerator.workspaceToCode(workspace);
    expect(code).toContain('import time');
    expect(code).toContain('xrpTeam.start()');
    expect(code).toContain('while not xrpTeam.is_ready():');
    expect(code).toContain('xrpTeam.update()');
    expect(code).toContain('time.sleep(0.05)');
  });

  it('keeps team communication updated during Blockly sleep blocks', () => {
    workspace.newBlock('xrp_team_start');
    const sleep = workspace.newBlock('xrp_sleep');
    const seconds = workspace.newBlock('math_number');
    seconds.setFieldValue(15, 'NUM');
    connectValue(sleep, 'TIME', seconds);

    const code = pythonGenerator.workspaceToCode(workspace);
    expect(code).toContain('def xrp_sleep(duration_s):');
    expect(code).toContain('team.update()');
    expect(code).toContain('xrp_sleep(15)');
  });

  it('generates name-targeted events and typed mailbox reads', () => {
    const send = workspace.newBlock('xrp_team_send_to_name');
    send.setFieldValue('emotion', 'CHANNEL');
    send.setFieldValue('EVENT', 'MODE');
    const value = workspace.newBlock('math_number');
    value.setFieldValue(4, 'NUM');
    const target = workspace.newBlock('text');
    target.setFieldValue('Blue XRP', 'TEXT');
    connectValue(send, 'VALUE', value);
    connectValue(send, 'TARGET', target);

    const code = pythonGenerator.workspaceToCode(workspace);
    expect(code).toContain('xrpTeam.send("emotion", 4, target=\'Blue XRP\', mode="event")');

    const hasMessage = workspace.newBlock('xrp_team_has_message');
    hasMessage.setFieldValue('emotion', 'CHANNEL');
    const generated = pythonGenerator.workspaceToCode(workspace);
    expect(generated).toContain('xrpTeam.has_message("emotion")');
  });

  it('generates ID-targeted checks, reads, and sender name lookups', () => {
    const hasFromId = workspace.newBlock('xrp_team_has_message_from_id');
    hasFromId.setFieldValue('distance', 'CHANNEL');
    const source = workspace.newBlock('math_number');
    source.setFieldValue(2, 'NUM');
    connectValue(hasFromId, 'SOURCE', source);

    const readFromId = workspace.newBlock('xrp_team_read_from_id');
    readFromId.setFieldValue('distance', 'CHANNEL');
    const readSource = workspace.newBlock('math_number');
    readSource.setFieldValue(2, 'NUM');
    connectValue(readFromId, 'SOURCE', readSource);

    const senderName = workspace.newBlock('xrp_team_sender_name');
    senderName.setFieldValue('distance', 'CHANNEL');

    const generated = pythonGenerator.workspaceToCode(workspace);
    expect(generated).toContain('xrpTeam.has_message_from("distance", 2)');
    expect(generated).toContain('xrpTeam.read_from("distance", 2)');
    expect(generated).toContain('xrpTeam.sender_name("distance")');
  });

  it('generates an x-y position pair that can be sent as one value', () => {
    const vector = workspace.newBlock('xrp_team_vector2');
    const x = workspace.newBlock('math_number');
    const y = workspace.newBlock('math_number');
    x.setFieldValue(120, 'NUM');
    y.setFieldValue(-40, 'NUM');
    connectValue(vector, 'X', x);
    connectValue(vector, 'Y', y);

    const generated = pythonGenerator.workspaceToCode(workspace);
    expect(generated).toContain('(120, -40)');
  });

  it('hides position helper blocks from the team toolbox category', () => {
    const toolboxText = JSON.stringify(BlocklyConfigs.ToolboxJson);

    expect(toolboxText).not.toContain('xrp_team_vector2');
    expect(toolboxText).not.toContain('xrp_team_vector_x');
    expect(toolboxText).not.toContain('xrp_team_vector_y');
    expect(toolboxText).toContain('xrp_team_start');
    expect(toolboxText).toContain('xrp_team_send_to_name');
    expect(toolboxText).toContain('xrp_team_send_to_id');
  });
});
