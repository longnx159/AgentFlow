'use strict';
module.exports = function (RED) {
  for (const kind of ['start', 'task', 'review', 'condition', 'repeat', 'delay', 'end']) {
    function PassiveNode(config) {
      RED.nodes.createNode(this, config);
    }
    RED.nodes.registerType('af-' + kind, PassiveNode);
  }
};
