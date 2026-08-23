import * as Blockly from 'blockly/core';
import { pythonGenerator } from 'blockly/python';

const PIN_OPTIONS = [
  ['GPIO 6 (Servo 1)', '6'],
  ['GPIO 12', '12'],
  ['GPIO 13', '13'],
  ['GPIO 14', '14'],
  ['GPIO 15', '15'],
  ['GPIO 16', '16'],
  ['GPIO 17', '17'],
  ['GPIO 18', '18'],
  ['GPIO 19', '19'],
];

const buttonPressedBlock = {
  type: 'digital_push_button_v3_pressed',
  message0: 'Digital Push Button V3 on %1 is pressed?',
  args0: [
    {
      type: 'field_dropdown',
      name: 'PIN',
      options: PIN_OPTIONS,
    },
  ],
  output: 'Boolean',
  colour: 90,
  tooltip: 'Returns True while the active-high Digital Push Button V3 is pressed.',
  helpUrl: '',
};

const buttonValueBlock = {
  type: 'digital_push_button_v3_value',
  message0: 'Digital Push Button V3 value on %1',
  args0: [
    {
      type: 'field_dropdown',
      name: 'PIN',
      options: PIN_OPTIONS,
    },
  ],
  output: 'Number',
  colour: 90,
  tooltip: 'Returns the raw digital value: 0 or 1.',
  helpUrl: '',
};

const waitForPressBlock = {
  type: 'digital_push_button_v3_wait_press',
  message0: 'wait for Digital Push Button V3 press on %1',
  args0: [
    {
      type: 'field_dropdown',
      name: 'PIN',
      options: PIN_OPTIONS,
    },
  ],
  previousStatement: null,
  nextStatement: null,
  colour: 90,
  tooltip: 'Waits for a stable button press with a 25 ms debounce.',
  helpUrl: '',
};

const waitForReleaseBlock = {
  type: 'digital_push_button_v3_wait_release',
  message0: 'wait for Digital Push Button V3 release on %1',
  args0: [
    {
      type: 'field_dropdown',
      name: 'PIN',
      options: PIN_OPTIONS,
    },
  ],
  previousStatement: null,
  nextStatement: null,
  colour: 90,
  tooltip: 'Waits for a stable button release with a 25 ms debounce.',
  helpUrl: '',
};

Blockly.common.defineBlocksWithJsonArray([
  buttonPressedBlock,
  buttonValueBlock,
  waitForPressBlock,
  waitForReleaseBlock,
]);

function configureButton(block) {
  const pin = block.getFieldValue('PIN') || '6';
  const variableName = `digital_push_button_v3_${pin}`;

  pythonGenerator.definitions_['import_digital_push_button_v3'] =
    'from digital_push_button_v3 import DigitalPushButtonV3';

  pythonGenerator.definitions_[`${variableName}_setup`] =
    `${variableName} = DigitalPushButtonV3(pin=${pin}, active_high=True, use_pull_down=True)`;

  return variableName;
}

pythonGenerator.forBlock['digital_push_button_v3_pressed'] = function (block) {
  const variableName = configureButton(block);
  return [`${variableName}.is_pressed()`, pythonGenerator.ORDER_NONE];
};

pythonGenerator.forBlock['digital_push_button_v3_value'] = function (block) {
  const variableName = configureButton(block);
  return [`${variableName}.value()`, pythonGenerator.ORDER_NONE];
};

pythonGenerator.forBlock['digital_push_button_v3_wait_press'] = function (block) {
  const variableName = configureButton(block);
  return `${variableName}.wait_for_press(debounce_ms=25)\n`;
};

pythonGenerator.forBlock['digital_push_button_v3_wait_release'] = function (block) {
  const variableName = configureButton(block);
  return `${variableName}.wait_for_release(debounce_ms=25)\n`;
};
