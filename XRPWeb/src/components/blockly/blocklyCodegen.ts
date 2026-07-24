import * as Blockly from 'blockly/core';
import { pythonGenerator } from 'blockly/python';
import moment from 'moment';
import type { Workspace } from 'react-blockly';

export function blocklyToPython(ws: Workspace): string {
    const pythonCode = pythonGenerator
        .workspaceToCode(ws)
        .replace('from numbers import Number\n', 'Number = int\n');
    const blocklyCode = JSON.stringify(Blockly.serialization.workspaces.save(ws));
    const date = moment();
    const formatedDate = date.format('YYYY-MM-DD HH:MM:SS');
    return pythonCode + '\n\n\n## ' + formatedDate + '\n##XRPBLOCKS ' + blocklyCode;
}
